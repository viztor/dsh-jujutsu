# 09 — GitHub upstream, remotes, and nested forks

**Source turns:** 11, 12
**Status:** plausible `jj` behaviour throughout — this is the area where the
conversation is most useful and least wrong

## The question

> "can jj commit be sent upstream to github"
> "is jj git init good? … what about highly nested forks?"

## Bookmarks are the boundary

GitHub cannot receive anonymous commits, so anything leaving the machine needs
a named bookmark:

```bash
jj bookmark create my-feature-branch -r @
jj git push --bookmark my-feature-branch
```

For throwaway iteration there is a quick-PR form that auto-generates a bookmark
name (`push-sytrsqlnznzr` style) and prints the PR-creation link:

```bash
jj git push -c @
```

**PLAUSIBLE** — consistent with `jj`'s documented `jj git push -c` behaviour.

## Rewriting is safe to push

Because `jj` rewrites freely, `jj git push` behaves like
`git push --force-with-lease`: it updates an existing PR branch and runs
safety checks rather than blindly overwriting. This is the property that makes
the "edit the change, push again" review loop work without fixup commits:

```bash
jj edit <change_id>     # work directly in the change
jj git push             # PR file tree updates in place
```

**PLAUSIBLE.**

## Multi-remote (fork vs upstream)

```toml
[git]
fetch = "upstream"
push = "origin"
```

Then `jj git fetch` pulls from the official repo and `jj git push` targets the
fork. **PLAUSIBLE.**

## Tracking a mainline bookmark

```bash
jj bookmark track main@origin
```

Needed after `jj git init` so `jj` knows how to rebase local work on the
upstream head. **PLAUSIBLE.**

## Bridging `gh`

Tools like `gh` read standard Git ref heads, but `jj` keeps state in its
operation log. Export before running `gh pr create`:

```bash
jj git export
```

**PLAUSIBLE.** This is a real friction point and the conversation is right to
call it out.

## Nested forks: the three problems

Turn 12 is the most concretely useful part of the whole conversation. Three
real scaling problems, each with a fix:

### 1. Excessive remote refs

`jj git fetch` in an environment with hundreds of forks imports _every_
reference into the operation store, which slows the CLI down. Fix: restrict the
fetch patterns to what you actually track.

```toml
[git]
fetch = ["refs/heads/main", "refs/tags/*"]
```

### 2. No `git worktree`

`git-worktree` is explicitly unsupported by the `jj` backend. Isolation is via
`jj`'s own workspaces:

```bash
jj workspace add ../nested-fork-feature
```

A distinct working directory over the same repository storage. **VERIFIED**
that it works, and **corrected**: in a colocated repo `jj workspace add` prints
"Created Git worktree for the new workspace" — so the claim that
`git-worktree` is unsupported is too strong. `jj` does not let you _use_
`git worktree` for isolation, but it uses one internally. Measured layout of the
secondary workspace: `.jj/` is a directory, `.git` is a file pointing at
`../<main>/.git/worktrees/<name>` — see
[13](13-empirical-verification.md#2-secondary-workspaces-jj-is-a-directory-git-is-a-file--corrected).
This makes [project detection](03-project-detection.md) a per-workspace
question.

### 3. No sparse-checkout passthrough, no partial clones

`jj` does not use Git's sparse-checkout engine or `--filter=blob:none`, so
mapping a large nested monolith can cost disk. Use `jj`'s own sparse:

```bash
# Name what to KEEP; jj has no "exclude this" flag.
jj sparse set --clear --add src --add docs
jj sparse reset          # undo: back to the whole working copy
```

**Corrected against `jj` 0.46.0.** An earlier draft of this section said
`jj sparse set --minus "path/to/heavy"`. That is wrong twice over: `--minus` is
not a flag (`error: unexpected argument '--minus' found` — the real ones are
`--add`, `--remove` and `--clear`), and `--remove` does not exclude anything
either. Sparse patterns are an **inclusion** set, so while the set is `.`
(include everything) removing a child changes nothing — verified: after
`jj sparse set --remove heavy`, `heavy/` was still on disk and `jj sparse list`
still showed `.`. Naming the paths to keep is what works:
`jj sparse set --clear --add small.txt` reported `removed 1 files` and the
directory was gone.

## What the conversation implies but does not say

- **These are user-configuration fixes, not plugin features.** `fetch`
  patterns, remotes, and sparse settings live in `jj` config. A plugin could
  _detect_ a pathological config and suggest the fix — that is the useful
  product — but it should not silently rewrite the user's `config.toml`.
- **`jj git export` is the compatibility seam for everything else.** Any tool
  that reads `.git` (editors, `gh`, Turborepo, CI shims — see
  [10](10-workflow-compatibility.md)) needs an export first. That is a
  candidate for automatic execution before `bash` commands that invoke such
  tools, and it is the strongest argument _against_ a blanket Git block in a
  colocated repo.

## Verification note

Nothing in this document was checked against the installed `jj` binary — this
machine has none. All of it is **PLAUSIBLE** and should be re-verified against
the `jj` version the project pins before it becomes a design dependency.
