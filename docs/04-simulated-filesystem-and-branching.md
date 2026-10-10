# 04 — Simulated filesystem and branching

**Source turn:** 5
**Status:** almost entirely fabricated — kept as a record of what was claimed

## The question

> "what if there is only simulated file system how does deepseekharness handle
> this what about branching"

## What the conversation claimed

- DSH exposes virtualized file tools `vfs_read` / `vfs_write`.
- Detection should key off virtual paths such as `/sandbox/jiujitsu-core`.
- DSH handles branching through **"State Snapshot Isolation"**: "the harness
  forks the virtual context array or clones the JSON state object".
- **"Parallel Reasoning Trails"** — each branch is "a clean, isolated session
  state fork"; a successful pathway is "committed back to your main database",
  a failed one is "simply dropped".
- A five-step workflow in which the guard inspects "virtual VFS paths" and
  branch transitions are "managed purely as session-level state snapshots".

## What is actually true

| Claim | Verdict |
|---|---|
| `vfs_read` / `vfs_write` tools exist | **CONTRADICTED.** No such tools. The filesystem tools are `read`, `write`, `edit`, `glob`, `grep`, backed by `dsh-tool-fs` / `dsh-tool-fs-search` |
| A "simulated file system" mode exists | **CONTRADICTED as described.** There *is* a sandbox backend (`dsh-fs-sandbox`) and a policy layer (`dsh-fs-observation-policy`), but the filesystem is the real one, confined — not a virtual tree |
| "State Snapshot Isolation" / "Parallel Reasoning Trails" | **UNVERIFIED.** No such mechanism found. Branching in the harness is `jj`'s job, not the harness's |
| `/sandbox/jiujitsu-core` style virtual paths | **CONTRADICTED.** Paths are real paths under the workspace root |
| The harness clones JSON state objects to branch | **CONTRADICTED.** Nothing in the harness does this |

The only salvageable idea is the general one: *if the filesystem were virtual,
the guard would key off the virtual path instead of the real one.* Since the
filesystem is real, that branch of the design is dead.

## Why this turn is worth keeping

It is the clearest demonstration of the failure mode that runs through the
whole conversation: **plausible-sounding architecture invented to satisfy a
question, with no grounding in the installed system.** "State Snapshot
Isolation" and "Parallel Reasoning Trails" are not DSH concepts; they are
capitalised nouns that make an answer *feel* authoritative.

The correct answer to "what about branching?" in a `jj` context is:

- `jj` branches natively and anonymously — a new change on top of any revision
  is a branch, no naming required (see [07](07-jujutsu-core-model.md)).
- A named branch is a **bookmark** (see [09](09-github-upstream-and-remotes.md)).
- There is no need for the harness to simulate any of it.

## Action

Nothing from this turn goes into the implementation. If a future reader finds
"State Snapshot Isolation" referenced anywhere in this repo, it is a mistake.
