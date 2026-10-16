/**
 * The `jujutsu` skill: the manual, moved out of the prompt and into the catalog.
 *
 * `docs/28` §1.5 splits the teaching surface three ways. The **rule** ("Git is
 * intercepted; use `jj`") and the **state** (root, layout, `@`) stay in
 * `systemPrompt`, because they must be true *before* the model's first Git
 * command. The **manual** becomes a runtime skill, which the model loads only
 * after it decides it needs one.
 *
 * **The split is for depth, not for tokens.** `docs/32` §Q3 measured the shipped
 * injection at 89 words ≈ 138 tokens, of which 38 words are the manual — so the
 * catalog line (30–77 tokens) buys back ~26 tokens with a short description and
 * *costs* 20 with a long one. It ships anyway because a skill body is unbounded:
 * it is paid only in the sessions that load it, and it can say the whole model
 * instead of the four sentences that fit in a prompt.
 *
 * Three properties are load-bearing:
 *
 * - **The description is a routing rule, not a table of contents.** It is the
 *   only signal the model sees in `<available_skills>` (`docs/28` §1.3), so it
 *   names Git and the verbs a user actually says. Capped at ~35 words for the
 *   reason above.
 * - **Registration degrades.** `ctx.inject(['skills'], …)` runs the callback
 *   only when the service is mounted — the same shape as the `systemPrompt`
 *   injection in `context.ts` — so a host without `ctx.skills` loses the manual
 *   and never fails to mount the guard.
 * - **The registration lands in the global layer.** A repository plugin is a
 *   host-plane row, so `register()` files the skill globally; a project skill of
 *   the same name in a nearer layer shadows it, which is the right default
 *   (`docs/32` §Q1).
 *
 * @module dsh-jujutsu/skill
 */

import type { Context } from "@deepseek-ai/cordis";

import type { Settings } from "./settings.ts";

/** The catalog name. Kebab-case, and the word the docs and the module use. */
export const SKILL_NAME = "jujutsu";

/**
 * The routing rule shown in the skill catalog.
 *
 * `docs/28` §1.5: "the description is the trigger, not a summary". Every verb
 * here is one the guard refuses (`docs/15` §1) or a word a user says when they
 * mean it, so the model can match a refused `git commit` or a plain "undo this"
 * to this skill without reading the body first.
 */
export const SKILL_DESCRIPTION = [
  "Jujutsu (jj) workspace reference: the working-copy model, change vs commit IDs,",
  "bookmarks, the op log, and the Git-to-jj verb map. Load it when a Git command",
  "is refused, or the user says commit, branch, rebase, undo, or push.",
].join(" ");

/**
 * The manual.
 *
 * Every command below is either executed by `src/tools.ts` or transcribed from
 * `docs/15-verb-mapping.md` §1, which was verified against `jj` 0.46.0. The
 * hunk query language is `docs/15` §5, verified by execution against
 * `jj-hunk` 0.5.1. Nothing here is invented, and nothing here is a promise the
 * tools do not keep.
 *
 * It is a template literal rather than a shipped `SKILL.md` asset on purpose
 * (`docs/28` §1.5 item 1): the manual must be readable and reviewable in the
 * plugin's own source, next to the tools whose contract it documents.
 */
export const SKILL_CONTENT = `# Jujutsu (jj) in this workspace

Version control here is Jujutsu, not Git. The bash tool intercepts \`git\` and
returns the \`jj\` command to run instead. \`jj git fetch\`, \`jj git push\`,
\`jj git clone\`, \`jj git init\`, \`jj git remote\`, \`jj git export\`,
\`jj git import\` and \`jj git root\` are Jujutsu commands and are never refused.

## The working-copy model

The working copy @ is always a commit and always dirty. There is no staging
index and nothing to add: editing a file changes \`@\` directly, a new file is
tracked as soon as it exists, and \`jj diff\` shows the change at once.
\`jj add\` does not exist.

\`jj new\` finalises \`@\` and starts a new empty change on top of it. That is
the commit gesture; there is no separate staging step. \`jj describe\` sets the
message of a change — its own or another revision's — and preserves the author.

Conflicts are recorded in-tree instead of aborting an operation, and \`jj new\`
**propagates** a conflict rather than escaping it. Resolve before building on
top: the tools that rewrite \`@\` — \`jj_new\`, \`jj_squash\` and
\`jj_hunk_apply\` — refuse while \`@\` is conflicted.

## Two ids per change

- **change ID** — a short stable identifier such as \`nsosovxq\`. It survives
  every rewrite, so it is the handle to use in instructions and revsets.
- **commit ID** — the content hash. It changes on every rewrite, so it is only
  meaningful for the exact revision you just read.

The tools return both and accept change IDs or revsets. Useful revsets: \`@\`
(the working copy), \`@-\` (its parent), \`::@\` (its ancestors), \`all()\`
(everything reachable).

## Bookmarks are the publish boundary

Jujutsu has no current branch. A bookmark is a named pointer, and it is the only
thing a Git remote can see:

    jj bookmark create <name> -r <rev>
    jj git push --bookmark <name>

There is no implicit push and no force flag: \`jj git push\` updates a remote
only if it still matches what you last fetched. \`jj git fetch\` imports remote
bookmarks; integrate with \`jj rebase -b <bookmark> -o <remote-bookmark>\`.

## The op log is the undo

Every mutation is an operation. \`jj op log\` lists them, and \`jj op restore
<op-id>\` puts the whole repository — working copy included — back to that
operation. \`jj undo\` reverses the last one. Nothing is lost to a rewrite: a
change dropped with \`jj abandon\` is still recoverable from the op log. This is
the recovery path for everything except a deleted \`.git\` or \`.jj\`.

## Git verb → jj

| Git | jj |
| --- | --- |
| \`git status\` | \`jj status\` |
| \`git diff\` | \`jj diff\` / \`jj diff -r <rev>\` |
| \`git log\` | \`jj log -r '::@'\` |
| \`git add\`, \`git add -p\` | nothing to stage; hunk selection is \`jj-hunk\` |
| \`git commit\` | \`jj commit -m "…"\` (the \`jj_new\` tool plus \`jj_describe\` do this in two steps) |
| \`git commit --amend\` | \`jj describe -m "…"\` to reword, \`jj squash\` to fold content |
| \`git branch\` | \`jj bookmark list\` / \`create\` / \`delete\` |
| \`git checkout\`, \`git switch\` | \`jj new <rev>\` to build on it, \`jj edit <rev>\` to enter it |
| \`git merge <rev>\` | \`jj new @ <rev>\` |
| \`git rebase\`, \`git rebase -i\` | \`jj rebase -s/-b/-r\`, \`jj squash\`, \`jj absorb\` |
| \`git reset --hard\` | \`jj abandon\` / \`jj restore <paths>\` |
| \`git stash\` | \`jj new @-\` to park it, \`jj edit <change-id>\` to return |
| \`git cherry-pick <rev>\` | \`jj duplicate <rev> -o <dest>\` |
| \`git revert <rev>\` | \`jj revert -r <rev> -B @\` |
| \`git push\` | \`jj git push --bookmark <name>\` |
| \`git pull\` | \`jj git fetch\`, then \`jj rebase -b <bookmark> -o <remote-bookmark>\` |
| \`git fetch\` | \`jj git fetch\` |
| \`git blame <file>\` | \`jj file annotate <path>\` |
| \`git show <rev>\` | \`jj show <rev>\` |
| \`git tag\` | \`jj tag list\` / \`set\` / \`delete\` |
| \`git bisect\` | \`jj bisect run <cmd>\` |
| \`git worktree add <path>\` | \`jj workspace add <path>\` |

\`git submodule\`, \`git lfs\` and \`git clean -fd\` have no jj equivalent. If a
task truly needs one, do it in a separate plain Git clone outside this
workspace.

## The eleven tools

Prefer these over shelling out: every one returns JSON rather than \`jj\`'s
graph-and-prose output, and the mutating ones refuse states that would corrupt
the graph.

Reads:

- \`jj_status\` — \`@\` and its parent, plus whether \`@\` is conflicted.
- \`jj_log\` — revisions newest-first; \`revset\` (default \`::@\`) and \`limit\`.
- \`jj_diff\` — the changed files of a revision (default \`@\`).
- \`jj_op_log\` — the operation log; the recovery path.

Mutations:

- \`jj_new\` — finalise \`@\` and start a change on top; optional \`revset\`
  parent and \`message\`.
- \`jj_describe\` — set a description; \`message\` is required, \`revset\`
  defaults to \`@\`.
- \`jj_squash\` — fold \`from\` into \`into\`; both default to \`@\`.
- \`jj_bookmark\` — \`list\`, \`create\`, \`set\`, \`move\`, \`delete\`, \`forget\`,
  \`rename\`, \`track\`, \`untrack\`. \`move\` takes \`--to\`; \`create\` and
  \`set\` take \`-r\`.
- \`jj_op_restore\` — restore the repository to an \`opId\` from \`jj_op_log\`.

Hunk-level, backed by \`jj-hunk\`:

- \`jj_hunk_list\` — preview the hunks a \`query\` selects.
- \`jj_hunk_apply\` — \`split\`, \`commit\` or \`squash\` the selection;
  \`query\` is required, and \`message\` is required for \`split\` and
  \`commit\`.

What the tools refuse, and why:

- \`jj_new\` and \`jj_hunk_apply split|commit\` refuse when \`user.name\` or
  \`user.email\` is unset, because the commit they would mint could not be
  pushed. Fix it with \`jj config set --user user.name "…"\` and the same for
  \`user.email\`.
- \`jj_new\`, \`jj_squash\` and \`jj_hunk_apply\` refuse while \`@\` is conflicted.
  The others do not, on purpose: \`jj_describe\` edits a message and
  \`jj_bookmark\` moves a ref, neither of which touches the conflicted tree, and
  \`jj_op_restore\` is the recovery path — refusing it would block the way out.
- All of them need \`jj\` 0.46.0 or newer, and none of them opens an interactive
  editor: pass the query, the message and the revset as arguments.

### Selecting hunks

Always select with \`query\`, never with a saved hunk id. Ids are regenerated
whenever the working copy changes, and a spec file written inside the working
copy invalidates the ids it contains.

Predicates: \`added()\`, \`removed()\`, \`changed()\`, \`renamed()\`,
\`mode_changed()\`, \`binary_changed()\`, \`all()\`, \`none()\`,
\`id("hunk-…")\`. Fields: \`content:\` (substring, case-sensitive) and
\`path:\` (glob). Modifiers: \`substring:\`, \`glob:\`, \`regex:\`,
\`exact:\`. Combine with \`&\`, \`|\`, \`~\` and parentheses. \`file:\` parses
but never matches anything — do not use it.

Examples:

    added(content:"TIMEOUT_MS")
    added(path:"src/server.js") & added(content:"TIMEOUT_MS")
    removed()
    added(content:regex:"(?i)todo|fixme")

A rename, a mode change and a binary change each select the *file* but yield no
hunks, so "0 hunks" from one of those queries means there is nothing to apply,
not that the query failed.
`;

/**
 * The slice of `ctx.skills` this module uses.
 *
 * Declared structurally rather than imported from `@deepseek-ai/dsh-skill`:
 * that package is not a dependency, and a policy plugin that named a capability
 * it does not own would fail to typecheck on a host that does not ship it. Same
 * reason `tools.ts` declares its own `ToolRegistry`.
 */
interface SkillRegistry {
  register(skill: {
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly content: string;
  }): () => void;
}

/** The context a `ctx.inject(['skills'], …)` callback receives. */
interface SkillScope {
  readonly skills?: SkillRegistry;
}

/**
 * Register the `jujutsu` skill.
 *
 * Called unconditionally by `apply`; the gate is here because this module is
 * directly testable and `teachSkill` must mean "the catalog never gains the
 * line", not "the line is registered and ignored" (`SPEC.md` §6).
 */
export function applySkill(ctx: Context, settings: Settings): void {
  if (!settings.teachSkill) return;

  // `inject` is guaranteed by the Cordis context contract, but this is the one
  // *optional* contribution the plugin makes: a host or a test double with no
  // service resolver must lose the manual, never the mount.
  const inject = (ctx as { inject?: unknown }).inject;
  if (typeof inject !== "function") return;

  ctx.inject(["skills"], (scope) => {
    const registry = (scope as unknown as SkillScope).skills;
    // `inject` already waits for the service to be mounted; this is the second
    // half, for a host whose accessor resolves but is empty. Registering nothing
    // is the documented degrade (`docs/28` §1.5 item 1) — the guard still mounts.
    if (registry === undefined || typeof registry.register !== "function") return;

    try {
      registry.register({
        name: SKILL_NAME,
        source: "bundled",
        description: SKILL_DESCRIPTION,
        content: SKILL_CONTENT,
      });
    } catch {
      // A rejected registration — a name collision the registry refuses, a
      // malformed entry — must not fail the plugin load. The guard is the
      // load-bearing half; this is a manual.
    }
  });
}
