/**
 * The `jujutsu` skill: a short card in the catalog, not a manual in the prompt.
 *
 * `docs/28` §1.5 splits the teaching surface three ways. The **rule** ("Git is
 * intercepted; use `jj`") and the **state** (root, layout, `@`) stay in
 * `systemPrompt`, because they must be true *before* the model's first Git
 * command. The **card** becomes a runtime skill, which the model loads only after
 * it decides it needs one.
 *
 * **The card is deliberately short, because the binary is the manual.** `jj help
 * <subcommand>` and `jj help -k <topic>` are local, free, and always match the
 * installed version; anything the card copied would drift. What the card keeps
 * is the part `jj help` cannot answer: the Git → jj intent map (a model that
 * knows Git asks "what replaces `git rebase -i`", not "which jj subcommand takes
 * `-b`"), the plugin's tool surface, the hunk query language, and the three things
 * that make jj different enough to get wrong. Verbose prose was deleted, not
 * moved: a card that explains `jj help` to the model is paying twice.
 *
 * Three properties are load-bearing:
 *
 * - **The description is a routing rule, not a table of contents.** It is the
 *   only signal the model sees in `<available_skills>` (`docs/28` §1.3), so it
 *   names Git and the verbs a user actually says. It is 206 characters today and
 *   may not exceed the 214-character break-even (`test/skill.test.ts`, `docs/32`
 *   §Q3): past that the catalog line costs more than the injection it replaced.
 * - **Registration degrades.** `ctx.inject(['skills'], …)` runs the callback
 *   only when the service is mounted — the same shape as the `systemPrompt`
 *   injection in `context.ts` — so a host without `ctx.skills` loses the card
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
  "Jujutsu (jj) workspace reference: working-copy model, change vs commit IDs,",
  "bookmarks, op log, Git-to-jj verb map. Load when a Git command is refused, or",
  "the user says commit, branch, rebase, undo, or push.",
].join(" ");

/**
 * The card.
 *
 * Every command below is either executed by `src/tools.ts` or transcribed from
 * `docs/15-verb-mapping.md` §1, which was verified against `jj` 0.46.0. The
 * hunk query language is `docs/15` §5, verified by execution against
 * `jj-hunk` 0.5.1. Nothing here is invented, and nothing here is a promise the
 * tools do not keep.
 *
 * It is a template literal rather than a shipped `SKILL.md` asset on purpose
 * (`docs/28` §1.5 item 1): the card must be readable and reviewable in the
 * plugin's own source, next to the tools whose contract it documents.
 */
export const SKILL_CONTENT = `# Jujutsu (jj) in this workspace

Version control here is Jujutsu: the bash tool intercepts \`git\` and returns
the \`jj\` command instead. The installed binary is the source of truth — use
\`jj help <subcommand>\` or \`jj help -k <topic>\` for what this card omits.

## The model

- The working copy \`@\` is always a commit and always dirty. No staging, no
  \`jj add\`: a new file is tracked as soon as it exists.
- \`jj new\` finalises \`@\` and starts an empty change on top — the commit
  gesture. \`jj commit -m "…"\` does both; \`jj describe -m "…"\` rewords and keeps
  the author.
- Change IDs survive rewrites; commit IDs do not. Revsets: \`@\`, \`@-\`, \`::@\`,
  \`all()\`.
- Conflicts are recorded in-tree: \`jj_new\`, \`jj_squash\` and \`jj_hunk_apply\`
  refuse while \`@\` is conflicted; \`jj_describe\` and \`jj_op_restore\` do not.

## In this workflow

Six rules; \`docs/41-jj-workflow-patterns.md\` in the repository carries the
measured failure behind each.

1. **A message is data.** Pass it to \`jj_commit\`/\`jj_describe\`. In bash,
   single-quote it or use \`jj describe --stdin\`: a double-quoted message runs
   backticks as commands, and \`jj commit\` then reads the mangled words as file
   paths.
2. **The commit type picks the release version** (\`fix:\` patch, \`feat:\` minor,
   \`feat!:\` major). Choose it deliberately; fix it before pushing, not after the
   release PR merges.
3. **Rewriting a published commit needs \`allowImmutable:true\`.** Without it the
   call fails with \`JJ_COMMIT_IMMUTABLE\`. The root commit is never the target.
4. **A push after a rewrite is already the safe push** — there is no \`--force\`.
5. **\`jj git fetch\`, then \`jj new main\`.** The bookmark does not follow, so
   \`jj bookmark set main -r <rev>\` before pushing.
6. **\`jj op log\` is the undo** — \`jj op restore <op-id>\` never touches the remote.

## Git → jj

| Git | jj |
| --- | --- |
| \`git commit\` | \`jj commit -m "…"\` (or \`jj_new\` + \`jj_describe\`) |
| \`git commit --amend\` | \`jj describe -m "…"\`, \`jj squash\` to fold content |
| \`git add\`, \`git add -p\` | nothing to stage; hunk selection is \`jj-hunk\` |
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
| \`git reflog\` | \`jj op log\` (every operation is reversible with \`jj op restore\`) |

\`git lfs\` and \`git clean -fd\` have no jj equivalent; a task that truly needs
one belongs in a separate plain Git checkout. Submodules are not in that group:
jj records them as Git does and they keep working, but jj does not manage them —
there is no \`jj submodule\` command, so updating one is the user's job or a plain
Git checkout's.

## The tools

Prefer these over shelling out: each returns JSON rather than jj's
graph-and-prose output, and the mutating ones refuse states that would corrupt
the graph. Reads pass \`--ignore-working-copy\`, so a history read never captures
another agent's half-written files; \`jj_status({snapshot:true})\` is the one
read that writes, and it returns the checkpoint \`opId\`.

- Read: \`jj_status\` (\`opId\`, \`divergent\`, \`conflicts\`; \`snapshot\`), \`jj_log\`,
  \`jj_diff\` (\`interdiff\`), \`jj_show\`, \`jj_file\`, \`jj_evolog\`, \`jj_op_log\`.
- Author: \`jj_new\`, \`jj_describe\`, \`jj_commit\`, \`jj_edit\`, \`jj_squash\`,
  \`jj_hunk_list\`, \`jj_hunk_apply\`.
- History and recovery: \`jj_history\`, \`jj_repair\`, \`jj_op\`, \`jj_op_restore\`.
- Workspaces and verification: \`jj_workspace\`, \`jj_coordinate\`, \`jj_group\`,
  \`jj_doctor\`, \`jj_test\`, \`jj_fix\`.
- Publish: \`jj_bookmark\`, \`jj_publish\` (\`push\`/\`fetch\`/tags; push asks or
  denies by default).

Every rewriting mutation returns \`opId\`; destructive ones also return
\`beforeOpId\`, which \`jj_op({action:"restore", opId: beforeOpId})\` undoes.

What they refuse: a missing \`user.name\`/\`user.email\` (fix with
\`jj config set --user user.name "…"\`), a conflicted \`@\` for the tools that
rewrite it, and anything interactive — pass the query, message and revset as
arguments. The message is quoted once at the argv edge, so backticks, quotes and
\`$(…)\` in it are literal. That is why a message goes through the tool.

## Selecting hunks

Select with \`query\`, never a saved hunk id: ids regenerate whenever the working
copy changes. Predicates \`added()\`, \`removed()\`, \`changed()\`, \`renamed()\`,
\`mode_changed()\`, \`binary_changed()\`, \`all()\`, \`none()\`; fields \`content:\` and
\`path:\` with \`substring:\`/\`glob:\`/\`regex:\`/\`exact:\`; combine with \`&\`, \`|\`, \`~\`.
Examples: \`added(content:"TIMEOUT_MS")\`, \`added(content:regex:"(?i)todo|fixme")\`.
A rename, mode or binary change selects the file but yields no hunks.
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
  // service resolver must lose the card, never the mount.
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
      // load-bearing half; this is a card.
    }
  });
}
