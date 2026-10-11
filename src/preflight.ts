/**
 * Preflight: the environmental checks, run once per session.
 *
 * ## Where it runs, and why not `session/created`
 *
 * `session/created` fires first, but it is a synchronous `emit`: async work there
 * is **not awaited** and rejections are only logged. `agent/created` is `serial`
 * and **awaited before session creation resolves**, with `AgentLoop` holding
 * queued input — and `SessionHeader.cwd` is already available, so no tool call is
 * needed to learn the root.
 *
 * ## And why this body is wrapped
 *
 * A throw in an `agent/created` listener **fails session creation**. That is a
 * larger blast radius than the guard's, where a throw costs one tool call. The
 * `try`/`catch` here is not defensive style; it is the difference between a
 * degraded check and a session the user cannot start.
 *
 * ## What it gathers
 *
 * Detection, the `@` change ID, and `jj-hunk` availability — the three values
 * `context.ts` needs but cannot fetch, because `systemPrompt` providers are
 * synchronous. Outside a `jj` workspace it gathers nothing, so a plain-Git
 * session costs exactly one `ctx.fs.stat`.
 *
 * The full check list, with its caches and invalidation rules, is
 * `docs/26-preflight-and-error-taxonomy.md` Part A.
 *
 * @module dsh-jujutsu/preflight
 */

import type { Context } from "@deepseek-ai/cordis";

import { detect } from "./detect.ts";
import type { Settings } from "./settings.ts";
import { runJj } from "./shell.ts";
import { setWorkspaceState } from "./state.ts";

interface SessionLike {
  readonly id?: string;
  readonly header?: { readonly cwd?: string };
}

/** Register the preflight listener. */
export function applyPreflight(ctx: Context, settings: Settings): void {
  ctx.on("agent/created", async (payload) => {
    try {
      const agent = (payload as { agent?: { session?: SessionLike } }).agent;
      const session = agent?.session;
      const sessionId = session?.id;
      const cwd = session?.header?.cwd;
      if (typeof sessionId !== "string" || typeof cwd !== "string") return;

      const workspace = await detect(ctx, cwd);

      if (workspace.kind === "none") {
        // Not a `jj` workspace. Record whatever *does* govern — a plain Git repo
        // or nothing at all — so the prompt can say something useful instead of
        // going silent. This is the case the plugin used to have no opinion
        // about, which meant an agent could work for an hour in a directory with
        // no history and never mention it.
        setWorkspaceState(sessionId, {
          vcs: workspace.vcs,
          root: workspace.vcsRoot === "" ? cwd : workspace.vcsRoot,
        });
        return;
      }

      setWorkspaceState(sessionId, {
        vcs: "jj",
        root: workspace.root,
        kind: workspace.kind,
        jjHunk: await hasJjHunk(ctx, settings, workspace.root),
        ...(await changeId(ctx, settings, workspace.root)),
      });
    } catch (error) {
      // Never fail session creation. A broken preflight must not cost the user
      // their session; the checks degrade to their lazy per-call fallbacks.
      // Reported anyway: "degraded to the lazy fallback" and "never ran" look
      // identical from the outside.
      console.error("[dsh-jujutsu] preflight failed, using per-call fallbacks:", error);
    }
  });
}

/**
 * Is `jj-hunk` runnable?
 *
 * A direct capability probe (`--help`, exit 0) rather than a version read:
 * `jj-hunk` has **no version flag** — `--version`, `-V` and `version` all error
 * — so version detection is tiered and the tier that always works is "does it
 * run" (`docs/33-probe-results-jj.md` §1).
 */
async function hasJjHunk(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<boolean> {
  try {
    const result = await runJj(ctx, settings.jjHunkPath, ["--help"], {
      cwd,
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** The short change ID of `@`, when `jj` will tell us. */
async function changeId(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<{ changeId?: string }> {
  try {
    const result = await runJj(
      ctx,
      settings.jjPath,
      ["log", "--no-graph", "-T", "change_id.short()", "-r", "@"],
      { cwd, timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) return {};
    const id = result.stdout.trim();
    return id.length > 0 ? { changeId: id } : {};
  } catch {
    return {};
  }
}
