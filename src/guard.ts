/**
 * The guard: a `tools/pre-execute` listener that refuses Git inside a `jj`
 * workspace and names the exact `jj` command instead.
 *
 * ## The contract, and why each clause is not optional
 *
 * All four were established by source trace in
 * `docs/31-probe-results-pipeline.md` Q1 and confirmed live in
 * `docs/35-probe-results-live.md`:
 *
 * - **The whole body is wrapped in `try { … } catch { return next(); }`.** A
 *   throwing listener becomes a tool error that **skips `post-execute`
 *   entirely**, so one detector bug breaks every `bash` call *and* silently
 *   removes the second channel.
 * - **Return `deny`; never throw to deny.** Throwing produces a `final-result`
 *   (`dsh-tools/lib/index.js:3267-3271`) that never reaches `postExecute`.
 * - **Never `exec.deferContext()` here.** Context deferred in a pre-execute
 *   listener is read only on the *dispatch* path (`:3333-3340`), so on a denial
 *   it is silently dropped.
 * - **Attach the explanation from `tools/post-execute`** — see `explain.ts`.
 *
 * @module dsh-jujutsu/guard
 */

import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

import { isRemembered } from "./bypass.ts";
import { detect, effectiveCwd, invalidateDetection, mayChangeLayout } from "./detect.ts";
import { markAsked, markDenied } from "./explain.ts";
import { invalidateMarkers, markerFor } from "./marker.ts";
import { classifyInvocation } from "./parse.ts";
import { type DestructiveTarget, destructiveTargetsVcs } from "./paths.ts";
import { refusalReason } from "./translate.ts";
import type { Settings } from "./settings.ts";
import { JJ_ADOPTION_REFUSED, JJ_NO_WORKSPACE, DESTRUCTIVE, WRITE_PROTECTION } from "./messages.ts";
import { workspaceState } from "./state.ts";
import { type Refusal, classifyGitInvocation, classifyJjInvocation } from "./verbs.ts";

/**
 * The guard's own error codes, carried on a `deny` as `info.code`.
 *
 * `docs/26` documented these as `info.code` values before the guard set any —
 * the harness has always allowed it (`PreToolDecision`'s deny arm declares
 * `info?: ToolErrorInfo`, whose own comment says durable projections keep it and
 * model-facing content does not), and nothing was using it. The doc was right and
 * the code was incomplete.
 *
 * They are not the model's business: `reason` is what the model sees, and these
 * exist so a log or a durable projection can say *which* rule fired without
 * parsing prose.
 */
export const GUARD_CODES = {
  gitDenied: "GUARD_GIT_DENIED",
  internalsWrite: "GUARD_JJ_INTERNALS_WRITE",
  repoStoreDelete: "GUARD_REPO_STORE_DELETE",
  jjWithoutWorkspace: "GUARD_JJ_NO_WORKSPACE",
} as const;

/** Tools whose `file_path` argument is checked against `.jj` and `.git`. */
const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/** The argument name the filesystem tools use, as the model sends it. */
const PATH_ARG = "file_path";

/** Read/write tools that only read. `read` of `.jj` is legitimate. */
const READ_ONLY_PATH_TOOLS: ReadonlySet<string> = new Set(["read"]);

/**
 * The slice of the approval service this plugin needs.
 *
 * Structural rather than imported: the plugin declares no dependency on
 * `@deepseek-ai/dsh-user-approval`, and the three members it uses are stable
 * (`docs/17-bypass-and-approval.md`).
 */
interface ApprovalLike {
  overrideOf(session: unknown): "ask" | "never" | undefined;
  readonly config?: { readonly policy?: "ask" | "never" };
}

/** Register the guard. */
export function applyGuard(ctx: Context, settings: Settings): void {
  if (!settings.guard) return;

  // A `jj git init` or `jj workspace add` turns a plain directory into a
  // workspace. Detection is cached per root, so a cached "none" has to be
  // dropped after one — otherwise the plugin stays blind for the rest of the
  // session, which is acceptance criterion 7 in docs/12 §H.
  ctx.on("tools/post-execute", async (exec, _result, next) => {
    try {
      const command = readCommand(exec);
      if (command !== undefined && mayChangeLayout(command)) {
        invalidateDetection();
        invalidateMarkers();
      }
    } catch {
      // Never let cache maintenance change a result.
    }
    return next();
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      return await decide(ctx, exec, next, settings);
    } catch (error) {
      // Fail open, and never let a detector bug escape: a throw here becomes a
      // tool error that skips post-execute for *every* call, not just this one.
      //
      // But fail open **loudly**. Swallowing this silently means a broken
      // detector disables the guard for the rest of the session and nothing
      // anywhere says so — the user would conclude the plugin simply had
      // nothing to refuse. The tag matches the harness convention
      // (`cordis-client-runner` reports render failures the same way); the host
      // writes to stderr, so this cannot disturb a protocol stream on stdout.
      console.error("[dsh-jujutsu] guard failed, allowing this call:", error);
      return next();
    }
  });
}

async function decide(
  ctx: Context,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
  settings: Settings,
): Promise<PreToolDecision> {
  // 0. The per-project switch, before anything else — including the destructive
  //    path rule, because `{"enabled": false}` must mean the plugin is *off*
  //    here, not "off except for the checks it thinks are important".
  const root = effectiveCwd(exec);
  if (root === undefined) return next();
  const marker = await markerFor(ctx, root);
  if (marker !== undefined && !marker.enabled) return next();

  // 1. Writes into the version-control internals, on any tool that takes a path.
  if (PATH_TOOLS.has(exec.name)) {
    const refusal = classifyPathWrite(exec);
    return refusal === undefined
      ? next()
      : gate(ctx, exec, refusal, settings, GUARD_CODES.internalsWrite);
  }

  // 2. Shell commands. Git is only reachable through `bash` — there is no git
  //    tool to disable (`docs/11-verified-dsh-api-contract.md` §7).
  if (exec.name !== "bash") return next();

  const command = readCommand(exec);
  if (command === undefined) return next();

  // 2a. Destructive paths first: `rm -rf .git` is not a Git invocation, so the
  //     verb rule below is blind to it by design — and it is unrecoverable.
  const destructive = destructiveTargetsVcs(command);
  if (destructive !== undefined) {
    return gate(ctx, exec, destructiveRefusal(destructive), settings, GUARD_CODES.repoStoreDelete);
  }

  // 2b. Decide whether we are even in a `jj` workspace. Outside one, the plugin
  //     must be invisible — unless the user forced Jujutsu (`forceJj`), in which
  //     case `jj` is refused before it can fail with `There is no jj repo in "."`
  //     and the refusal names the command that creates the workspace.
  const workspace = await detect(ctx, root);
  if (workspace.kind === "none") {
    if (!(marker?.forceJj ?? settings.forceJj)) return next();
    const invocation = classifyInvocation(command);
    const refusal = classifyJjInvocation(invocation);
    if (refusal.kind === "allow") return next();
    // A repository the adoption probe refused is not one where `jj git init` is
    // the answer; the message sends the model back to Git instead.
    const refused = adoptionRefused(exec);
    return {
      kind: "deny",
      reason: (refused ? JJ_ADOPTION_REFUSED : JJ_NO_WORKSPACE).reason,
      info: { name: "dsh-jujutsu", code: GUARD_CODES.jjWithoutWorkspace },
    };
  }

  // 2c. Classify. A `jj git init` or `jj workspace add` may have just changed
  //     the layout, so the cache is dropped before the next call is judged.
  const invocation = classifyInvocation(command);
  if (invocation.gitInvocations.length === 0) return next();

  const decision = classifyGitInvocation(invocation);
  return decision.kind === "allow"
    ? next()
    : gate(ctx, exec, decision, settings, GUARD_CODES.gitDenied);
}

/**
 * Did adoption fail in this session?
 *
 * Only preflight knows: the probe runs once, at `agent/created`, and its refusal
 * is recorded in the session state. When it did, `jj` is not merely missing a
 * workspace — `jj git init` here is the corruption the probe exists to prevent,
 * so the refusal must not suggest it.
 */
function adoptionRefused(exec: ToolExecution): boolean {
  const sessionId = exec.agent?.session.id;
  if (sessionId === undefined) return false;
  return workspaceState(sessionId)?.adoption?.status === "blocked";
}

/**
 * Turn a refusal into a decision.
 *
 * The posture depends on whether the command only reads: `readOnlyGit` governs
 * the read-only ones and `bypass` governs the rest, because a user who is happy
 * to let the model *look* with Git has not thereby agreed to let it *write*.
 *
 * The approval-policy read is **three-term** — `overrideOf(session) ??
 * config.policy ?? 'ask'`. `overrideOf` deliberately excludes the deployment
 * default, so a two-term read misreads every deployment that configured one:
 * under the shipped `danger-full-access` mode the service short-circuits to
 * `rejected` while a two-term read concludes `ask`, and the harness then
 * substitutes *"the user rejected tool bash"*, losing our message entirely
 * (`docs/17-bypass-and-approval.md`).
 */
function gate(
  ctx: Context,
  exec: ToolExecution,
  refusal: Refusal,
  settings: Settings,
  code: string,
): PreToolDecision {
  const posture = refusal.readOnly ? settings.readOnlyGit : settings.bypass;
  if (posture === "allow") return { kind: "allow" };

  // A verb the user already approved in this session is not asked about again.
  const sessionId = exec.agent?.session.id;
  if (
    posture === "ask" &&
    settings.rememberBypass &&
    sessionId !== undefined &&
    isRemembered(sessionId, refusal.verb)
  ) {
    return { kind: "allow" };
  }

  // The reason is composed once, for both postures: when static analysis
  // produced the concrete `jj` command for the arguments as typed, the model
  // gets that verbatim (`translate.ts`); otherwise the catalogue message
  // stands. Composing only on the deny arm would have been the worse bug —
  // `readOnlyGit: 'ask'` is the shipped default, so the *common* path would
  // have kept handing back the generic string while the tests, which pin
  // `readOnlyGit: 'deny'`, all passed.
  const reason = refusalReason(refusal.source ?? "", refusal.equivalent, refusal.message.reason);

  if (posture === "deny" || !isPromptable(ctx, exec)) {
    markDenied(exec, refusal);
    // `info` is for durable diagnostics; the model sees only `reason`. The
    // harness's own type comment says the same thing, which is why the code is
    // safe to put here and useless in the message.
    return {
      kind: "deny",
      reason,
      info: { name: "dsh-jujutsu", code },
    };
  }

  markAsked(exec, refusal);
  // `displayReason` stays the family string from `docs/25` §2.3: the human
  // approving the call is deciding about the consequence, not the syntax.
  return {
    kind: "ask",
    reason,
    displayReason: { en: refusal.message.display ?? refusal.message.reason },
  };
}

/**
 * Can the user actually be asked?
 *
 * Under `approval/policy: 'never'` every ask resolves `rejected` *and*
 * `dsh-tools` replaces our reason with its own, so asking there is strictly
 * worse than denying with our message.
 */
function isPromptable(ctx: Context, exec: ToolExecution): boolean {
  const approval = ctx.get("approval") as ApprovalLike | undefined;
  if (approval === undefined) return false;
  const session = exec.agent?.session;
  if (session === undefined) return false;
  const policy = approval.overrideOf(session) ?? approval.config?.policy ?? "ask";
  return policy !== "never";
}

/** Read `exec.arguments.command` without asserting. */
function readCommand(exec: ToolExecution): string | undefined {
  const args = exec.arguments;
  if (args === null || typeof args !== "object") return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

/**
 * Refuse a write whose resolved path names `.jj` or `.git`.
 *
 * Reads are allowed — inspecting `.jj` is how the model learns what a Jujutsu
 * repo looks like, and it produces no message. Writes are not: `.jj` holds the
 * operation log, and corrupting it is less recoverable than corrupting `.git`.
 *
 * The path is matched on the **exact component**, never a prefix, so
 * `.gitignore` and `.github/` are untouched.
 */
function classifyPathWrite(exec: ToolExecution): Refusal | undefined {
  if (READ_ONLY_PATH_TOOLS.has(exec.name)) return undefined;
  const args = exec.arguments;
  if (args === null || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>)[PATH_ARG];
  if (typeof path !== "string") return undefined;

  const target = vcsComponent(path);
  if (target === undefined) return undefined;
  return {
    kind: "refuse",
    verb: `write:${target}`,
    classification: "deny",
    message: WRITE_PROTECTION[target],
    readOnly: false,
  };
}

/**
 * Is any path component exactly `.jj` or `.git`?
 *
 * **Any** component, not just the last: a write to
 * `.jj/working_copy/tree_state` is a write into `.jj`, and checking only the
 * basename misses every real case. A leading `~` or a `$VAR` is left to
 * `ctx.fs.resolve`, which is where relative paths get their meaning.
 */
function vcsComponent(path: string): "jj" | "git" | undefined {
  for (const component of path.split("/")) {
    if (component === ".jj") return "jj";
    if (component === ".git") return "git";
  }
  return undefined;
}

/**
 * The message for a destructive path.
 *
 * It must say the operation is **unrecoverable** and name the non-destructive
 * alternative. `jj git colocation disable` is the safe way to get what
 * `rm -rf .git` is usually reaching for, and `jj op restore` is the recovery for
 * everything *except* this. Copy: `docs/25-prompt-copy.md` §2.
 */
function destructiveRefusal(target: DestructiveTarget): Refusal {
  return {
    kind: "refuse",
    verb: `rm:${target}`,
    classification: "deny",
    message: DESTRUCTIVE[target],
    // De-colocating a repo is a legitimate, deliberate act, so a human may
    // approve it — but a computed path must be asked about, never allowed.
    readOnly: false,
  };
}

/**
 * Is this a `jj` command that may have changed the workspace layout?
 *
 * Used to drop the detection cache. A cached "none" must not survive a
 * `jj git init`, or acceptance criterion 7 in `docs/12` §H fails.
 */
export { mayChangeLayout };
