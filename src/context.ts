/**
 * Teaching the model: the rule and the state here, the manual in `skill.ts`.
 *
 * The seam is `ctx.systemPrompt`, and the pattern is copied from
 * `dsh-user-approval`'s own registration — `ctx.inject(['systemPrompt'], scope =>
 * …)`, a namespaced name, an order resolved from the central table, and a
 * provider function that returns `''` when it has nothing to say. An empty
 * string contributes nothing, which is what makes conditional injection free.
 *
 * Two contributions, and the split matters:
 *
 * | Content | Home | Cost |
 * |---|---|---|
 * | the **rule** ("Git is intercepted; use `jj`") | `section` at `TOOL_BASH` | every assembly — it must be there *before* the first Git command |
 * | the **state** (root, layout, `@`, `jj-hunk`, the manual's name) | `context` at order 130 | every assembly — it changes |
 * | the **manual** (how to drive `jj`) | a `jujutsu` skill | one catalog line; the body loads on demand |
 *
 * **The skill split is not a token saving.** Measured before the pointer line:
 * the real injection was 89 words ≈ 138 tokens, of which 38 words were movable,
 * against a catalog line costing 30–77 — a net −26 tokens at best and **+20**
 * with a long description. It ships because a skill lets the manual be
 * *complete* instead of capped at 38 words, while the pointer line (13 words)
 * makes the card discoverable without paying for its body. The card itself was
 * cut to ~670 words by deferring flags and syntax to `jj help`, which is local,
 * free and always matches the installed binary; only what `jj help` cannot
 * answer (the Git-intent map, the eleven tools, hunk selection) stayed. Keep the
 * skill description at or under the 214-character break-even from
 * `docs/32-probe-results-teaching.md` §Q3, or the split costs more than it
 * saves; it is 206 characters today.
 *
 * Order `130` is the next free slot: `CONTEXT_ORDERS` holds only 110
 * (`SANDBOX_POLICY`), 115 (`APPROVAL_POLICY`) and 120 (`SUBAGENT_DELEGATION`).
 *
 * Both providers are **synchronous** by contract, so they read the state that
 * `preflight.ts` gathered at `agent/created` rather than probing anything here.
 *
 * @module dsh-jujutsu/context
 */

import type { Context } from "@deepseek-ai/cordis";

import { blockerText } from "./adopt.ts";
import type { Settings } from "./settings.ts";
import { workspaceState } from "./state.ts";

/** The next free runtime-context slot after the three reserved ones. */
const CONTEXT_ORDER = 130;

/**
 * The rule. Verbatim from `docs/25-prompt-copy.md` §1.1 — 68 words, and it must
 * stay under the combined ~200-word budget.
 */
const POLICY_TEXT = [
  "Version control here is Jujutsu (jj). The bash tool intercepts git and returns the",
  "jj command to run instead; there is no Git mode. Use jj for every version-control",
  "step. The working copy @ is always a commit and always dirty: no staging, nothing",
  "to add. Address revisions by change ID, which survives rewrites; commit IDs do not.",
  "Bookmarks are the publish boundary: jj git push --bookmark <name>.",
].join("\n");

/** The merge-extensible assembly context, narrowed to the one field used here. */
interface AssembleContextLike {
  readonly agent?: {
    readonly session?: {
      readonly id?: string;
      readonly header?: { readonly cwd?: string };
    };
  };
}

/** Register the rule and the state. */
export function applyContext(ctx: Context, settings: Settings): void {
  if (!settings.injectContext) return;

  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.section({
      name: "jujutsu:bash-policy",
      order: scope.systemPrompt.getSectionOrder("TOOL_BASH"),
      text: (context) => {
        const state = stateOf(context);
        // The rule is about driving `jj`. Stating it in a directory with no
        // Jujutsu would be false, and in a plain Git repo actively misleading.
        return state?.vcs === "jj" ? POLICY_TEXT : "";
      },
    });

    scope.systemPrompt.context({
      name: "jujutsu:workspace",
      order: CONTEXT_ORDER,
      text: (context) => renderState(context, settings),
    });
  });
}

/** The gathered state for the assembling agent, when there is one. */
function stateOf(context: unknown) {
  const sessionId = (context as AssembleContextLike | undefined)?.agent?.session?.id;
  if (typeof sessionId !== "string") return undefined;
  return workspaceState(sessionId);
}

/**
 * The state block, or `''` outside a `jj` workspace when `forceJj` is off.
 *
 * With `forceJj` on, a directory that has no workspace still gets a two-line
 * block naming the refusal and `jj git init --colocate` — the refusal must be
 * legible before the model trips over it.
 *
 * Shape from `docs/25-prompt-copy.md` §1.2; the `{{a | b}}` alternatives are
 * resolved here rather than emitted.
 */
function renderState(context: unknown, settings: Settings): string {
  const state = stateOf(context);
  if (state === undefined) return "";

  // No version control at all. Say so, and say what to do about it — the
  // plugin is otherwise silent here, and silence reads as "nothing to report".
  if (state.vcs === "none") {
    // `forceJj` changes the advice from "offer to initialise" to "initialise
    // first, jj will be refused until you do". Saying nothing about the refusal
    // would let the model discover it by trying a command.
    if (state.forceJj) {
      return [
        `Version control: none. ${state.root} is not inside a Git or Jujutsu repository.`,
        "Jujutsu is required here: jj commands are refused until a workspace exists. Initialise one with: jj git init --colocate",
      ].join("\n");
    }
    if (!settings.alertUninitialised) return "";
    const init = settings.preferJj
      ? "jj git init  (creates a colocated repo; Git tooling still works)"
      : "git init";
    return [
      `Version control: none. ${state.root} is not inside a Git or Jujutsu repository.`,
      `If the work here should be tracked, offer to initialise one with: ${init}`,
    ].join("\n");
  }

  // A plain Git repo. Without `forceJj` the guard is deliberately inactive —
  // the plugin only governs `jj` workspaces — so the prompt says what is true
  // rather than implying a policy that is not in force. Under `forceJj` the jj
  // guard *is* active here, and the old "guard is inactive" line would
  // contradict the sentence that follows it.
  if (state.vcs === "git") {
    const lines = [
      state.forceJj
        ? "Version control: Git (no Jujutsu workspace here). Git is not guarded; jj is required."
        : "Version control: Git (no Jujutsu here). The jj guard is inactive in this directory.",
      `Repository root: ${state.root}`,
    ];
    // Adoption was attempted and refused. Say so, and say why: "jj is not
    // available here" on its own reads as a missing install, and the model would
    // have no way to tell a user what to change. The blocker is a fact about the
    // repository, so it is worth one sentence.
    if (state.adoption?.status === "blocked") {
      lines.push(
        `Jujutsu cannot be used here: ${blockerText(state.adoption.blocker ?? "git-file")}.`,
      );
    } else if (state.forceJj) {
      // The guard will refuse `jj` here, and the model has to know that before
      // it tries one — this is the line that turns a refusal into an instruction.
      lines.push(
        "Jujutsu is required here: jj commands are refused until a workspace exists. Initialise one with: jj git init --colocate",
      );
    }
    return lines.join("\n");
  }

  const layout =
    state.kind === "jj-colocated"
      ? "colocated with Git (.git and .jj both present)"
      : "native jj, no .git";
  const hunk = state.jjHunk
    ? `jj-hunk available (${settings.jjHunkPath})`
    : "jj-hunk not installed, hunk tools unavailable";

  const lines = [
    `Workspace root: ${state.root}`,
    `Layout: ${layout}`,
    `Working copy @: ${state.changeId ?? "unknown"}`,
    `Hunk selection: ${hunk}`,
    // The card itself is loaded on demand; this line is the only thing that
    // tells the model it exists. Without it, a cold start has to discover the
    // skill catalog entry by accident, or reinvent the verb map.
    "Manual: load the jujutsu skill for the verb map and tool details.",
  ];
  // Adopted this session: say so, and name the one rule that follows from it.
  // The repository may have Git users who never agreed to Jujutsu, so history
  // that has been pushed is not this agent's to rewrite — that is a workflow
  // constraint the prompt is the only place to state.
  if (state.adoption?.status === "adopted") {
    lines.unshift(
      "Adopted: this Git repository is now a Jujutsu workspace (colocated; Git tooling still works). Other people may use Git here, so prefer additive operations and do not rewrite published history.",
    );
  }
  return lines.join("\n");
}
