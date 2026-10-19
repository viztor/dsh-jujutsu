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

The write is small and reversible — **but the undo is `rm -rf .jj`, not
`jj git colocation disable`**. That command does something much larger: it moves
`.git` into `.jj/repo/store/git` and removes Git from the working tree, after
which `git status` answers `fatal: not a git repository`. Following it as an
"undo" is a far more invasive change than the adoption itself.

```bash
rm -rf .jj        # the undo: back to a plain Git repository
```

`.git` is **not** untouched. The import writes `refs/jj/keep/*` and new objects
into it, which is how jj records what it has exported; `rm -rf .jj` leaves those
refs behind. What adoption does not change is the branch history and the working
tree, which is why a Git user who never learns jj exists is unaffected.

## 2. The compatibility probe

Seven refusals, in this order. The order matters: a repository with several
problems always reports the same one, so the message a user sees does not change
between sessions.

| Blocker       | Detected by                                                                                                                 | What jj actually does                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-file`    | `.git` is a **file** or a **symlink** (via `lstat`)                                                                         | A `.git` file (linked worktree, submodule checkout) makes `jj git init --colocate` print `Initialized a new colocated jj repo inside a Git worktree` and create a **second, unrelated repository**. A `.git` symlink is quieter and worse: two directories share one Git directory, each gets its own jj workspace, and a commit from one deletes the other's files from the shared repository. |
| `sparse`      | `.git/info/sparse-checkout`, or `core.sparseCheckout[Cone] = true`                                                          | **Corrupt.** jj does not know about the sparse cone, so every path outside it reads as deleted. `jj status` shows `D dirB/b.txt`, one commit removes those files from the shared history, and `git sparse-checkout disable` does not bring them back.                                                                                                                                           |
| `shallow`     | `.git/shallow`                                                                                                              | Imports the truncated history. After colocating a `--depth 1` clone, jj's view of `main` is the single imported commit, with no ancestry to rewrite.                                                                                                                                                                                                                                            |
| `submodules`  | `.gitmodules`, or `.git/modules`                                                                                            | Prints `ignoring git submodule at "<path>"`. The gitlink and `.gitmodules` survive in commits, so history is intact — but jj never materialises or updates the submodule working copy, and an agent told "jj is available" operates on a tree that is missing it.                                                                                                                               |
| `lfs`         | `[filter "lfs"]` in `.git/config`, `.git/lfs`, or `filter=lfs` in `.gitattributes` / `.git/info/attributes`                 | **Corrupt.** jj does not run the smudge filter. The commit holds the LFS pointer; the worktree holds the smudged bytes; they differ, so `jj status` reports `M big.bin` immediately after colocation and a commit writes the raw bytes over the pointer. Every other clone then gets a broken object.                                                                                           |
| `filters`     | any other `[filter "…"]` in `.git/config`, `core.autocrlf = true\|input`, or a `core.attributesFile` that declares a filter | **Corrupt, and worse than LFS.** The root cause is not LFS — jj runs no filters at all. A custom filter is how git-crypt and git-secret work, so the worktree holds the _decrypted_ file and jj commits **plaintext over the encrypted blob**: a secret-exposure incident. `core.autocrlf` commits CRLF over the LF-normalised blob.                                                            |
| `in-progress` | `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `sequencer`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`                  | Adopting mid-operation bakes a half-finished state into the import, and the user's next `git` command fights it. `sequencer/` is included because a multi-commit cherry-pick resolved with `git commit` rather than `--continue` leaves a pending pick with no `CHERRY_PICK_HEAD`.                                                                                                              |

`index.lock` is deliberately **not** a blocker: a stale lock is a common,
harmless annoyance, and refusing on it would block adoption for a reason the
user cannot see.

### LFS has four signals, and the strongest one is not the attributes file

The first version of this probe read only the repository root, which left a
documented false negative: a `filter=lfs` declared in a **nested**
`.gitattributes` was invisible, and closing it appeared to need a recursive walk
on the session-start path.

It does not. `git lfs install` writes a `[filter "lfs"]` section into
`.git/config`, and LFS cannot function without it — so one extra file read
answers the question at repository level, wherever the attributes live. The
probe checks, in order:

1. `[filter "lfs"]` in `.git/config` — catches nested attributes.
2. `.git/lfs` — the object store.
3. `.gitattributes` at the root.
4. `.git/info/attributes` — repo-local attributes, which need no working-tree
   file at all.

What remains uncovered is a repository that declares `filter=lfs` in a nested
`.gitattributes` **without** ever having run `git lfs install`. That repository's
LFS is already broken — Git stores the raw bytes too — so there is nothing for
the probe to protect.

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

**A failed import is undone.** `jj git init --colocate` is not atomic: an
unparseable ref, or a timeout on a large history, can leave a `.jj` that does not
work. That is the worst state to leave behind, because the _next_ session's
`detect` sees `.jj`, the guard activates, and every `jj` command fails — the
repository is bricked for the agent while Git keeps working outside the plugin.
So a failed import removes the `.jj` it created (and only one it created) and
reports `init-failed`. The workspace is also verified with one `jj log` after the
import, because exit 0 is not proof that jj can read the result.

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
