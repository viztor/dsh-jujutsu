# 03 — Conditional project detection

**Source turns:** 4, 9
**Status:** the idea is right, the detection signals are invented

## The question

> "conditionally detect for a project and use jijitsu"

The plugin must change behaviour **only** inside a Jujutsu workspace, and be a
no-op everywhere else. This is the correct instinct: a global Git block would
be hostile, and the harness is used across many unrelated repositories.

## What the conversation proposed

```ts
function isJiuJitsuProject(): boolean {
  const hasJiuJitsuConfig = fs.existsSync(path.join(projectRoot, 'jiujitsu.config.json'));
  const hasTechniquesDir = fs.existsSync(path.join(projectRoot, 'src/techniques'));
  ...
  return pkg.name?.includes('jiujitsu') || pkg.name?.includes('jiu-jitsu');
}
```

Three problems:

1. **`jiujitsu.config.json` and `src/techniques/` do not exist.** They are
   artifacts of the martial-arts misreading — see
   [01](01-framing-and-intent.md). **CONTRADICTED.**
2. **`fs.existsSync` on `node:fs` is the wrong API.** Plugins must use the
   harness filesystem service. See [05](05-filesystem-seam.md). **CONTRADICTED.**
3. **`process.cwd()` is not the workspace root.** It is whatever directory the
   process was started in, which is not guaranteed to be the agent's workspace.
   Detection must key off the execution's own workspace context.

Later in the same turn the conversation offers `ctx.fs.exists('/jiujitsu.config.json')`
and `ctx.fs.exists('/src/techniques')` — the API is closer to right, the paths
are still invented.

## What the detection signal should actually be

A Jujutsu workspace is identifiable from the filesystem, and the signals are
ordered by strength:

| Signal | Strength | Note |
|---|---|---|
| `.jj/` directory at the workspace root | **definitive** | Present in every `jj` repo, colocated or not |
| `.jj/repo` / `.jj/working_copy` | definitive | Internal layout; version-sensitive |
| `.jj/` **and** `.git/` both present | definitive, and *colocated* | The interesting case — see [07](07-jujutsu-core-model.md) |
| `jj config` / `jj root` succeeds | definitive, but requires spawning a process | Slower; use as confirmation, not as the primary check |

The conversation never mentions `.jj/` once. That is the whole detection
problem, and it is a two-line check.

## The colocated complication

`jj git init` produces a repo with **both** `.jj/` and `.git/`. So "is this a
jj project?" is not the same question as "should Git be blocked?":

- `.jj/` only → native `jj`; Git commands are meaningless. Blocking is free.
- `.jj/` + `.git/` → colocated. Git *works*, and other tools (editors, `gh`,
  CI shims) legitimately use it. Blocking Git for the agent may still be right,
  but the harness must not pretend `.git` is absent.
- `.git/` only → not our business. Return `next()`.

The conversation treats colocation as a benefit in turns 12–13 and as
something to block in turns 2–9, without noticing the conflict. This is the
same unresolved tension flagged in [01](01-framing-and-intent.md) and
[12](12-risks-and-open-questions.md).

## Recommended shape

```ts
// Pseudocode — verify the exact workspace-access API before implementing.
function detectWorkspace(exec) {
  const root = workspaceRootFor(exec);        // NOT process.cwd()
  return {
    hasJj:   ctx.fs.exists(join(root, '.jj')),
    hasGit:  ctx.fs.exists(join(root, '.git')),
  };
}
```

Then:

- `hasJj === false` → `return next()`, always.
- `hasJj === true` → engage the guard from
  [02](02-git-blocking-at-tool-call-level.md).
- `hasJj && hasGit` → engage, but report colocation in the denial text so the
  model understands why Git is refused in a repo where Git would work.

Cache the detection per workspace, and invalidate on `jj` operations that
could create or remove a workspace.

## Open questions

- Detection per **execution** or per **session**? A session can touch several
  workspaces.
- What about `jj workspace add` (see
  [09](09-github-upstream-and-remotes.md)) — a second working directory for the
  same repo. Each workspace root needs its own detection. Measured: in a
  secondary workspace `.jj/` is still a **directory** and `.git` becomes a
  **file** pointing at a Git worktree, so a plain `isDirectory('.jj')` test
  works in both — see
  [13](13-empirical-verification.md#2-secondary-workspaces-jj-is-a-directory-git-is-a-file--corrected).
