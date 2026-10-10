# 10 — Workflow compatibility

**Source turns:** 13, 14
**Status:** plausible and useful; it is the compatibility matrix the plugin has
to satisfy, not a description of the plugin

## Why this area exists

A `jj` workspace that breaks the rest of the toolchain is not adoptable. The
conversation's turn 13 walks four layers and, for each, names the failure and
the fix. That structure is worth keeping.

## 1. AI coding assistants and editors (Cursor, Copilot, Trae, …)

- **What works:** a colocated workspace keeps a standard Git working directory,
  so editors see modified files and diffs normally.
- **What breaks:** an assistant that auto-generates a commit message or clicks
  "commit" emits `git commit`. If the harness blocks Git, that path fails.
- **Fix:** route commit gestures through `jj commit -m "…"`, or rely on `jj`'s
  automatic working-copy commits, where every file save is already recorded
  into `@` (see [07](07-jujutsu-core-model.md)).

**Consequence for `dsh-jujutsu`:** the denial message in
[02](02-git-blocking-at-tool-call-level.md) must name `jj` equivalents for
exactly these gestures. This is the most common real-world failure.

## 2. pnpm monorepos and Turborepo

- **What breaks:** Turborepo decides which packages changed and whether a build
  cache is reusable by reading Git hashes. If `.git` refs are stale, cache keys
  go stale.
- **Fix, as the conversation gives it:** run `jj git export` before the build,
  or keep it on a file-watch hook:

  ```bash
  jj git export && pnpm build
  ```

  **Corrected by measurement.** In a colocated workspace — which `jj git init`
  produces by default — `jj git export` prints *"No export needed in colocated
  workspaces."* and the bookmark is already a Git branch
  ([13 §3](13-empirical-verification.md#3-jj-git-export-is-a-no-op-in-colocated-workspaces--important)).
  So this fix is **unnecessary in the default configuration** and only matters
  for `--no-colocate` repos. The Turborepo hazard is much smaller than the
  conversation implies.
- **Secondary risk:** lockfile churn. Switching change pathways changes the
  working directory instantly, so `pnpm-lock.yaml` can look out of sync unless
  package changes are committed to a stable parent revision.

**Consequence for `dsh-jujutsu`:** drop the "auto-run `jj git export`"
idea from the first draft. There is no export to run in the default setup, and
the previous draft's argument for it — that three of five layers need `.git` to
be current — collapses because `jj` keeps it current for you.

## 3. CI/CD and stacked pull requests

Stacked PRs are `jj`'s strongest workflow advantage:

| Step | Git | `jj` |
|---|---|---|
| Dependency updates | manual conflict resolution across branches | concurrent change IDs rebase automatically when `main` moves |
| Creating a chain | `git checkout -b feature2` off `feature1`, track parents by hand | `jj new` over an existing change ID |
| Submitting PRs | push separate branch names, link in the GitHub UI | `jj git push -c <rev>` pushes each commit as its own PR |

- **Automated churn:** when a bot merges a PR, `jj git fetch` rebases local
  stacked changes onto the new head without a manual conflict cycle.
- **CI triggers:** GitHub Actions fire on named ref changes. Local experimental
  `jj` commits create no Git branch until a bookmark is attached, so work stays
  local until deliberately exported.

**Consequence for `dsh-jujutsu`:** the plugin should make the
"bookmark = publish boundary" explicit to the model. An agent that thinks it
has "pushed" when it has only created a change is a real hazard.

## 4. Code review (`gh`, CODEOWNERS)

- **Review sync:** `jj edit <change_id>` + `jj git push` updates the existing
  PR branch in place. No fixup-and-squash cycle. (See
  [09](09-github-upstream-and-remotes.md) for the force-with-lease semantics.)
- **CODEOWNERS:** line-by-line ownership checks can run locally against
  `jj-hunk`-parsed hunks before anything is pushed, catching authorisation
  problems before CI. (See [08](08-jj-hunk.md).)

## The matrix, condensed

| Layer | Reads `.git`? | Needs an export first? | Blocked by a blanket Git ban? |
|---|---|---|---|
| Editors / AI assistants | yes | no — `jj` keeps refs current when colocated | commit gestures only |
| Turborepo / build caches | yes (hashes) | no, in the default colocated layout | only the `git`-shaped cache reads |
| GitHub Actions | no (remote) | no | no |
| `gh` CLI | yes (ref heads) | no, in the default colocated layout | `gh` itself is fine; only a literal `git` call is refused |
| CODEOWNERS local checks | no | no | no |

The earlier draft's claim that "three of five layers need `.git` to be
current, which is why a blanket Git ban cannot be the whole design" does not
survive measurement: with a colocated repo, `jj` maintains `.git` itself, so
no layer is starved by blocking the agent's own `git` commands. That weakens
the case for an export bridge and **strengthens** the case for the guard in
[02](02-git-blocking-at-tool-call-level.md) — the only thing the ban costs is
the agent's own `git` invocations, which is exactly what we want to remove.
