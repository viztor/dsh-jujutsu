# 37 — Git-compatible adoption

**What it does.** A setting, `adoptGitRepos`, lets the plugin take over a plain
Git repository by running `jj git init --colocate`. `.jj` appears beside `.git`,
the history is imported, and the agent gets Jujutsu — while `git log`,
`git status`, `git fetch` and every other Git tool keep working, because `.git`
is still the source of truth and jj keeps it in sync.

**What it refuses.** Repositories that jj cannot represent faithfully. The
probe is static — directory and file reads, no `jj` process — and runs before
anything is written.

Sources: [13](13-empirical-verification.md) (measured jj behaviour),
[29](29-state-config-and-sandbox-surfaces.md) (config and the marker),
[26](26-preflight-and-error-taxonomy.md) (where preflight runs). Every claim
about jj below was measured on 0.46.0 while this document was written.

---

## 1. Why a setting rather than behaviour

Adoption **writes to the user's repository**. Nothing else this plugin does has
that property: the guard refuses commands, the prompt injects text, the tools
run `jj` against a workspace that already exists. Creating `.jj` is a mutation,
so it is off by default and turning it on is the consent.

The write is small and reversible:

```bash
jj git colocation disable   # removes .jj, leaves the repository as it was
# or, equivalently for this purpose
rm -rf .jj
```

`.git` is never modified by the import, which is why a Git user who never
learns jj exists is unaffected.

## 2. The compatibility probe

Five refusals, in this order. The order matters: a repository that is both
shallow and submoduled always reports `shallow`, so the message a user sees does
not change between sessions.

| Blocker       | Detected by                                                                                   | What jj actually does                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git-file`    | `.git` is a file                                                                              | `jj git init --colocate` prints `Initialized a new colocated jj repo inside a Git worktree` and creates a **second, unrelated repository** inside the worktree. `.git` is a file in a linked worktree and in a submodule checkout.                                                                                       |
| `shallow`     | `.git/shallow`                                                                                | Imports the truncated history. After colocating a `--depth 1` clone, jj's view of `main` is the single imported commit, with no ancestry to rewrite.                                                                                                                                                                     |
| `submodules`  | `.gitmodules`, or `.git/modules`                                                              | Prints `ignoring git submodule at "<path>"`. The gitlink and `.gitmodules` survive in commits, so history is intact — but jj never materialises or updates the submodule working copy, and an agent told "jj is available" operates on a tree that is missing it.                                                        |
| `lfs`         | `.gitattributes` declaring `filter=lfs`, or `.git/lfs`                                        | **The dangerous one.** jj does not run Git's clean/smudge filters. The commit holds the LFS pointer; the worktree holds the smudged bytes; they differ, so `jj status` reports `M big.bin` immediately after colocation and a commit writes the raw bytes over the pointer. Every other clone then gets a broken object. |
| `in-progress` | `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` | Adopting mid-operation bakes a half-finished state into the import, and the user's next `git` command fights it.                                                                                                                                                                                                         |

`index.lock` is deliberately **not** a blocker: a stale lock is a common,
harmless annoyance, and refusing on it would block adoption for a reason the
user cannot see.

### What the probe does not cover

A `.gitattributes` in a subdirectory can also declare `filter=lfs`. Scanning the
whole tree for that means a recursive walk on the session-start path, so only
the repository root is read. A root `.gitattributes` is where LFS is initialised
in practice, and the failure mode of this gap is the status quo: the plugin does
nothing in a plain Git repo at all.

## 3. Where it runs, and why

`preflight.ts`, at `agent/created` — the same seam that gathers the workspace
state, for the same reason: the prompt providers are synchronous and cannot do
this work themselves. The listener is already wrapped in a `try`/`catch` because
a throw there fails session creation; `adoptRepo` returns its failures rather
than throwing, so a repository the plugin cannot adopt still gets a session.

After a successful import the detection cache is invalidated **before** the
re-detect. Without that, the session would hold the "plain git" answer it
gathered a moment earlier, and the guard would stay inactive in the repository
that was just adopted.

## 4. The per-project override

`.dsh-jujutsu.json` ([29](29-state-config-and-sandbox-surfaces.md) §3) gains an
optional `adopt` boolean:

| Marker               | Effect                                                 |
| -------------------- | ------------------------------------------------------ |
| `{"adopt": true}`    | adopt here even when the global setting is off         |
| `{"adopt": false}`   | do not adopt here, even when the global setting is on  |
| `{"enabled": false}` | the plugin is off entirely, so adoption is off with it |
| absent               | follow `adoptGitRepos`                                 |

The `false` direction is the useful one. The global setting applies to every
plain Git repository a session opens, and a monorepo or a vendored checkout is
exactly where that should not happen.

## 5. What the prompt says

Two sentences, in `context.ts`:

- **Adopted:** the repository is now a Jujutsu workspace, colocated, Git tooling
  still works — and, because other people may use Git here, prefer additive
  operations and do not rewrite published history. That last clause is the only
  workflow constraint the plugin can state, and it is the one that matters: a
  Git user who never opted into jj is downstream of everything the agent does.
- **Blocked:** jj cannot be used here, with the blocker's sentence. Without it,
  "jj is not available" reads as a missing install and the model has no way to
  tell the user what to change.

## 6. What this is not

- **Not a conversion.** No history is rewritten and `.git` is untouched.
- **Not the no-VCS case.** A directory with neither `.jj` nor `.git` already has
  a path — the `alertUninitialised` / `preferJj` suggestion — and creating a
  repository from nothing is a different decision from adopting one that exists.
- **Not `jj workspace add`.** A linked Git worktree is refused, and the correct
  jj tool for that shape is a workspace, which this plugin does not manage.
