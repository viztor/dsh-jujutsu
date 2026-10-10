# 07 — Jujutsu core model

**Source turns:** 12, 14
**Status:** substantially correct — this is public `jj` behaviour, not harness
internals, which is why it holds up

## The question

> "for a jj project how does it handle git commit or git branch?"

and, earlier,

> "is jj git init good? does it work and how to make it work better?"

## The model, as described

**There is no staging area.** Every file edit is recorded automatically into an
open-ended working-copy revision, `@`. You do not `git add`; you do not
`git commit` to save work.

**Two identifiers per revision:**

| Identifier | Behaviour |
|---|---|
| **Change ID** | stable across rewrites — the conceptual change |
| **Commit ID** | a cryptographic hash that changes on every rewrite |

This split is the reason `jj` can rewrite history aggressively without losing
the thread of "which change is this" — and the reason a harness can safely
`jj squash` / `jj edit` / `jj rebase` without the model losing its place.

**Finalising** a change is `jj new`: it closes the current change ID and starts
a fresh empty working copy on top.

**Branches are anonymous by default.** Branching is just creating a new change
on top of an older revision — no name required. Because GitHub cannot receive
anonymous commits, `jj` translates names at the boundary using **bookmarks**
(see [09](09-github-upstream-and-remotes.md)).

The conversation's comparison table is accurate in shape:

| Operation | Git | `jj` |
|---|---|---|
| Save modifications | `git add` + `git commit` | automatic; `@` updates on every file save |
| Start a new task | `git checkout -b feature` | `jj new` (naming optional) |
| Rewrite previous work | `git commit --amend`, interactive rebase | `jj squash`, `jj edit <change_id>` |
| Prepare for remote push | push a branch name | `jj bookmark create <name>` then `jj git push` |

## Colocated init

`jj git init` initialises a **colocated** workspace: `.jj/` and `.git/` in the
same root, `jj` as a frontend over the Git backend. Recent `jj` versions
colocate by default (`--no-colocate` opts out). **PLAUSIBLE** — consistent with
the cited `jj` docs and with `jj` 0.42/0.43 release behaviour.

Consequences that matter for the plugin:

- Because `.git/` is present, **editors, `gh`, and CI tooling keep working** —
  which is exactly what [10](10-workflow-compatibility.md) relies on.
- Because `.git/` is present, **detection cannot be "no `.git` means `jj`"** —
  see [03](03-project-detection.md).
- Because both exist, blocking Git for the *agent* while leaving it available
  to *other tools* is a coherent position. The conversation never states it
  that clearly, but it is the only reading that satisfies both turns 9 and 13.

## What the harness must model

To be `jj`-native rather than Git-with-a-rename, the plugin needs to know:

1. **`@` is always dirty.** There is no "uncommitted" state to report the way
   `git status` does. Any status tool has to translate.
2. **History is mutable.** A commit ID the model saw last turn may no longer
   exist. Change IDs are the stable handle; tools should return and accept
   change IDs.
3. **Operation log.** `jj op log` records every operation and `jj op restore`
   can undo. This is a *better* safety net than Git's reflog and the plugin
   should surface it rather than reimplementing undo.
4. **Bookmarks are the only thing GitHub sees.** Anything intended to leave the
   machine needs a bookmark. See [09](09-github-upstream-and-remotes.md).

## Open questions

- Does the plugin expose `jj` as a **first-class tool set**
  (`jj_status`, `jj_new`, `jj_squash`, …) or only as **policy over `bash`**?
  The conversation assumes policy-over-bash throughout, but a first-class tool
  set would give the model change IDs as structured data instead of parsing
  terminal output. This is the largest unmade design decision in the project.
- Which `jj` version is the floor? Colocation-by-default and `jj sparse` both
  changed recently.
