# 15 — Git gesture → jj verb mapping

Source of truth for the guard's denial messages. Verified against `jj` 0.46.0
(`/opt/homebrew/bin/jj`) and `jj-hunk` 0.5.1 (`~/.cargo/bin/jj-hunk`), both run
with `JJ_CONFIG=/dev/null`.

Canonical cross-check: the upstream table at
`https://docs.jj-vcs.dev/latest/git-command-table/`. Every `jj` command named
below was additionally executed locally in a scratch repo.

## 1. Mapping table

`classification`: **DENY** = block and name the replacement · **ALLOW** = never
block · **SPECIAL** = needs different treatment, see footnote.

| Git command                                                                 | jj equivalent                                                | classification | denial message                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git status`                                                                | `jj status` (`jj st`)                                        | DENY           | Refused `git status`: this is a Jujutsu workspace. Run `jj status` (alias `jj st`) — it shows the working-copy change and its parent commit.                                                     |
| `git diff`                                                                  | `jj diff`                                                    | DENY           | Refused `git diff`: Jujutsu has no staging index. Run `jj diff` for the working-copy change, or `jj diff -r <rev>` for another revision.                                                         |
| `git log`                                                                   | `jj log`                                                     | DENY           | Refused `git log`: run `jj log`. Use `-r '::@'` for ancestors of `@`, or `-r 'all()'` for everything reachable.                                                                                  |
| `git add <path>`                                                            | none — auto-tracked                                          | DENY           | Refused `git add`: Jujutsu has no staging area. New files are tracked automatically — just edit the file and `jj status` / `jj diff` will show it.                                               |
| `git add -p`                                                                | `jj-hunk split\|commit\|squash --query`                      | DENY           | Refused `git add -p`: there is no index to stage into. For hunk-level selection run `jj-hunk commit --query '<hunkset>' "msg"` (`split` / `squash` also work).                                   |
| `git commit`                                                                | `jj commit`                                                  | DENY           | Refused `git commit`: run `jj commit -m "..."`. The Jujutsu working copy _is_ a commit, so this finalizes it and starts a new empty change on top.                                               |
| `git commit --amend`                                                        | `jj describe` (message) / `jj squash` (content)              | DENY           | Refused `git commit --amend`: `--amend` does not exist. Reword with `jj describe -m "..."`; fold edits into the parent with `jj squash`.                                                         |
| `git commit -m "msg"`                                                       | `jj commit -m "msg"`                                         | DENY           | Refused `git commit -m`: run `jj commit -m "..."`.                                                                                                                                               |
| `git branch`                                                                | `jj bookmark list` (`jj b l`)                                | DENY           | Refused `git branch`: Jujutsu calls branches _bookmarks_. Run `jj bookmark list` (alias `jj b l`).                                                                                               |
| `git branch -a`                                                             | `jj bookmark list --all-remotes`                             | DENY           | Refused `git branch -a`: run `jj bookmark list --all-remotes` to include remote-tracking bookmarks.                                                                                              |
| `git branch <name>`                                                         | `jj bookmark create <name> -r <rev>`                         | DENY           | Refused `git branch <name>`: run `jj bookmark create <name> -r <rev>`.                                                                                                                           |
| `git branch -d <name>`                                                      | `jj bookmark delete <name>`                                  | DENY           | Refused `git branch -d`: run `jj bookmark delete <name>`.                                                                                                                                        |
| `git checkout -b <name>`                                                    | `jj new` + `jj bookmark create <name> -r @-`                 | DENY           | Refused `git checkout -b`: run `jj new` to start a change, then `jj bookmark create <name> -r @-`. Jujutsu has no branch-switch step.                                                            |
| `git checkout <branch>`                                                     | `jj new <rev>` / `jj edit <rev>`                             | DENY           | Refused `git checkout <rev>`: run `jj new <rev>` to start a change on top of it, or `jj edit <rev>` to make it the working copy.                                                                 |
| `git switch <branch>`                                                       | `jj new <rev>` / `jj edit <rev>`                             | DENY           | Refused `git switch`: run `jj new <rev>` to start a change on top, or `jj edit <rev>` to make that revision the working copy.                                                                    |
| `git merge <rev>`                                                           | `jj new @ <rev>`                                             | DENY           | Refused `git merge`: run `jj new @ <rev>`. A merge is just a change with two parents; conflicts are recorded in-tree, so there is no `--continue`.                                               |
| `git rebase`                                                                | `jj rebase`                                                  | DENY           | Refused `git rebase`: run `jj rebase -s <src> -o <dest>` (move a subtree) or `jj rebase -b <bookmark> -o <dest>` (move a branch).                                                                |
| `git rebase -i`                                                             | `jj rebase -r … -B/-A`, `jj squash`, `jj split`, `jj absorb` | DENY           | Refused `git rebase -i`: it is interactive and unusable headless. Reorder with `jj rebase -r <rev> -B <rev>`; fold with `jj squash`; auto-place fixes with `jj absorb`.                          |
| `git reset --hard`                                                          | `jj abandon` / `jj restore`                                  | DENY           | Refused `git reset --hard`. Discard edits with `jj restore <paths>`; drop the current change with `jj abandon`. Both are reversible via `jj undo`.                                               |
| `git reset --soft HEAD~1`                                                   | `jj squash --from @-`                                        | DENY           | Refused `git reset --soft`: run `jj squash --from @-` to fold the parent's diff into the working copy. Jujutsu never rewrites a commit in place.                                                 |
| `git stash`                                                                 | `jj new @-`                                                  | DENY           | Refused `git stash`: Jujutsu has no stash. Run `jj new @-` to park the current change as a sibling commit; find it later in `jj log`.                                                            |
| `git stash pop`                                                             | `jj edit <change-id>`                                        | DENY           | Refused `git stash pop`: there is no stash to pop. Re-enter the parked change with `jj edit <change-id>` (locate it with `jj log`).                                                              |
| `git cherry-pick <rev>`                                                     | `jj duplicate <rev> -o <dest>`                               | DENY           | Refused `git cherry-pick`: run `jj duplicate <rev> -o <dest>` to copy that change onto another commit.                                                                                           |
| `git revert <rev>`                                                          | `jj revert -r <rev> -B @`                                    | DENY           | Refused `git revert`: run `jj revert -r <rev> -B @` to insert the inverse of `<rev>` just before the working copy.                                                                               |
| `git tag`                                                                   | `jj tag set` / `jj tag list` / `jj tag delete`               | DENY           | Refused `git tag`: run `jj tag list`, `jj tag set <name> -r <rev>`, or `jj tag delete <name>`.                                                                                                   |
| `git push`                                                                  | `jj git push --bookmark <name>`                              | DENY           | Refused `git push`: run `jj git push --bookmark <name>`. Jujutsu pushes bookmarks explicitly — there is no implicit current-branch push.                                                         |
| `git push --force`                                                          | `jj git push` (already force-with-lease)                     | DENY           | Refused `git push --force`: no force flag is needed. `jj git push` updates the remote only if it matches what you last fetched.                                                                  |
| `git pull`                                                                  | `jj git fetch` + `jj rebase`                                 | DENY           | Refused `git pull`: Jujutsu has no pull. Run `jj git fetch`, then `jj rebase -b <bookmark> -o <remote-bookmark>` to integrate.                                                                   |
| `git fetch`                                                                 | `jj git fetch`                                               | DENY           | Refused `git fetch`: run `jj git fetch`. Note the `jj` prefix — `jj git fetch` is a Jujutsu command and is never blocked.                                                                        |
| `git clone <url>`                                                           | `jj git clone <url>`                                         | DENY           | Refused `git clone`: run `jj git clone <url> [<dir>]`. It creates a colocated repo by default.                                                                                                   |
| `git remote -v`                                                             | `jj git remote list`                                         | DENY           | Refused `git remote -v`: run `jj git remote list`; add one with `jj git remote add <name> <url>`.                                                                                                |
| `git remote add <n> <url>`                                                  | `jj git remote add <n> <url>`                                | DENY           | Refused `git remote add`: run `jj git remote add <name> <url>`.                                                                                                                                  |
| `git worktree add <path>`                                                   | `jj workspace add <path>`                                    | DENY           | Refused `git worktree add`: run `jj workspace add <path>`. Workspaces are Jujutsu's native multi-working-copy feature.                                                                           |
| `git submodule …`                                                           | none                                                         | SPECIAL        | Refused `git submodule`: jj has no submodule _command_, but submodules already in the repository keep working — jj records them exactly as Git does. Ask the user to run it.                     |
| `git bisect …`                                                              | `jj bisect run`                                              | DENY           | Refused `git bisect`: run `jj bisect run <cmd>` — it finds the first bad revision automatically.                                                                                                 |
| `git blame <file>`                                                          | `jj file annotate <path>`                                    | DENY           | Refused `git blame`: run `jj file annotate <path>` to show the change that last modified each line.                                                                                              |
| `git show <rev>`                                                            | `jj show <rev>`                                              | DENY           | Refused `git show`: run `jj show <rev>` for the description plus diff.                                                                                                                           |
| `git clean -fd`                                                             | none                                                         | SPECIAL        | Refused `git clean -fd`: Jujutsu has no "untracked" state to clean. Inspect with `jj status`, then delete the files yourself with `rm`.                                                          |
| `git restore <path>`                                                        | `jj restore <path>`                                          | DENY           | Refused `git restore`: run `jj restore <paths>` to restore from the parent, or `jj restore --from <rev> <paths>`.                                                                                |
| `git init`                                                                  | `jj git init`                                                | DENY           | Refused `git init`: run `jj git init` (colocated by default) or `jj git init --no-colocate`.                                                                                                     |
| `git -C <dir> <sub>`                                                        | `jj -R <dir> <sub>`                                          | DENY           | Refused `git -C <dir>`: run `jj -R <dir> <sub>`, or `cd <dir>` first.                                                                                                                            |
| `git config …`                                                              | `jj config …`                                                | SPECIAL        | Refused `git config`: Jujutsu reads identity from its own config, not `.git/config`. Use `jj config set --user user.name "…"` / `jj config list`.                                                |
| `git lfs …`                                                                 | none                                                         | SPECIAL        | Refused `git lfs`: the `git` binary fronts this subcommand, so it cannot be allowed through. Jujutsu has no LFS integration; fetch LFS objects with a plain Git checkout outside this workspace. |
| `jj <anything>`                                                             | —                                                            | ALLOW          | — (never denied)                                                                                                                                                                                 |
| `jj git export\|fetch\|push\|clone\|init\|import\|remote\|root\|colocation` | —                                                            | ALLOW          | — (carve-out, see §2)                                                                                                                                                                            |
| `gh pr create` / `gh …`                                                     | —                                                            | ALLOW          | — (not a Git command; the guard matches the invoked program, not the string `gh`)                                                                                                                |

**SPECIAL footnotes**

- **`git submodule`** — there is no `submodule` token anywhere in `jj --help` or
  `jj git --help` (verified by grep; both returned nothing), so no `jj` replacement
  exists to name. But “no submodule subcommand” is not “no submodule support”:
  colocation imports the gitlink and leaves the checked-out submodule alone
  (measured against jj 0.46.0 — `git status` stays clean, `git submodule status`
  still works, the files are untouched). The refusal therefore asks the user to
  run the command instead of implying jj cannot coexist with submodules.
- **`git clean -fd`** — jj snapshots every non-ignored file, so files are either
  tracked or ignored; there is no third "untracked" bucket for `clean` to sweep.
  `jj file untrack <path>` exists but requires the path to already match an
  ignore pattern (`jj file untrack --help`: "They must already be ignored"), so
  it is not a substitute. Deleting is a filesystem action.
- **`git config`** — read-only reads (`git config --get`) are harmless, but a
  write is a silent no-op for jj's purposes. Verified: with
  `git config user.name "Git Config Name"` set in a colocated repo, `jj commit`
  still printed `Warning: Name and email not configured`. jj does **not** read
  `user.*` from `.git/config`.
- **`git lfs`** — `git-lfs` is also installed standalone at
  `/opt/homebrew/bin/git-lfs`, but the gesture an agent emits is `git lfs …`,
  whose first token is `git`. Allowing it would require special-casing a
  subcommand list; denying with an explicit explanation is cheaper and safer.

## 2. The `jj git` carve-out

The guard must resolve the **invoked program**, never scan the command text for
the token `git`. `jj git export` is a `jj` invocation; `git export` is not a
thing at all.

### Parsing rule

1. Split the command text on shell control operators: `;`, `&&`, `||`, `|`,
   `&`, and newline. Each fragment is a candidate simple command.
2. Within a fragment, strip, in order:
   - leading `VAR=value` assignments (`env FOO=1 git push` → `git push`);
   - leading wrapper words that exec their argument: `env`, `command`, `nohup`,
     `time`, `sudo`, `doas`, `exec`, `nice`, `xargs`;
   - `sh -c '…'` / `bash -c '…'` / `zsh -c '…'` / `eval '…'` → recurse into the
     quoted string as a fresh command text;
   - command substitutions `$(…)` and backticks → recurse into each.
3. Take the next word; if it contains `/`, take its basename.
4. **DENY only if that basename is exactly `git`** (or `git.exe` on Windows).
   `jj`, `jj-hunk`, `git-lfs`, `gh`, `lazygit` are not `git` and pass.

Because step 3 reads the _program_, `jj git export` resolves to program `jj` and
is allowed with no special case. The carve-out is therefore not a list of
exceptions — it falls out of the rule. The `jj git …` list below is what a
naive "contains `git`" guard would have wrongly denied, and is the regression
suite for the parser.

### Every `jj git <sub>` in 0.46

From `jj git --help`:

| Subcommand          | Note                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `jj git clone`      | creates a **colocated** repo by default (verified: output dir had both `.git` and `.jj`) |
| `jj git colocation` | nested: `disable`, `enable`, `status`                                                    |
| `jj git export`     | in colocated repos prints `No export needed in colocated workspaces.`                    |
| `jj git fetch`      |                                                                                          |
| `jj git import`     | in colocated repos prints the same "does nothing automatically" notice                   |
| `jj git init`       | colocated by default; `--no-colocate` opts out                                           |
| `jj git push`       |                                                                                          |
| `jj git remote`     | nested: `add`, `list`, `remove`, `rename`, `set-url`                                     |
| `jj git root`       | prints the underlying Git directory                                                      |

Nine top-level subcommands. Note there is **no `jj git pull`** and no
`jj git merge` — both are absent from `jj git --help`.

## 3. Colocated-repo pitfalls

Measured in `/tmp/verbmap` (`jj git init`, no flags → both `.git/` and `.jj/`).

### 3.1 Plain `git status` / `git log` work — but `git status` can be stale

**CONFIRMED, with a caveat the instructions did not mention.** They work and
they see jj state, but `git status` does **not** trigger a jj snapshot, so it
can report a state jj has not yet recorded:

```
$ jj git init && echo base > f.txt && jj commit -m base
$ echo brand-new > n.txt
$ git status --short
?? n.txt                      # git: untracked
$ jj status
Working copy changes:
A n.txt                       # jj: added
$ git status --short
 A n.txt                      # only now, after a jj command snapshotted
```

`git log` is accurate for committed state — after `jj commit -m "first from jj"`,
`git log --oneline` printed `c69760f first from jj`.

### 3.2 `git commit` succeeds and silently re-parents the jj working copy

**CONFIRMED in effect, CORRECTED in causation.** The instruction says `git
commit` "leaves the repo in detached HEAD". In fact the repo is _already_
detached before any `git commit` runs — jj writes a raw SHA into `.git/HEAD`
as soon as it takes over the working copy:

```
$ jj git init && cat .git/HEAD
ref: refs/heads/main         # symbolic, unborn

$ echo hello > a.txt && jj commit -m "first from jj" && cat .git/HEAD
c69760f2ee92feb9472cb145c662a5806d38228d      # detached already, from jj

$ git status
Not currently on any branch.
nothing to commit, working tree clean
```

`git commit` then succeeds and merely advances that detached HEAD:

```
$ echo world >> a.txt && git add a.txt
$ git commit -m "committed with git"
[detached HEAD d114518] committed with git
 1 file changed, 1 insertion(+)

$ cat .git/HEAD
d114518caf70b61644051628fda9480957127ae8

$ jj status
Reset the working copy parent to the new Git HEAD.
The working copy has no changes.
Working copy  (@) : mtsqztou e7d4e8f1 (empty) (no description set)
Parent commit (@-): ysulvrlp d114518c committed with git
```

So: `git commit` does not _create_ the detached HEAD, it _exploits_ it. The real
damage is the second half — jj auto-imports the Git commit and rewrites the
working-copy parent, exactly as the instruction describes. Denying `git commit`
in colocated repos is correct.

### 3.3 `jj git export` is a no-op in a colocated repo

**CONFIRMED verbatim.**

```
$ jj git export
No export needed in colocated workspaces.
```

The same run in a non-colocated repo (`jj git init --no-colocate`) printed
`Nothing changed.`, and `git status` there failed with `fatal: not a git
repository`. So the guard must not use `git status` working as a signal that a
repo is colocated.

## 4. What a text-matching guard cannot get right

The guard sees the `bash` tool's `command` string and nothing else. It has no
shell AST, no filesystem, and no view of what a subprocess will do.

### False positives — the guard would DENY something harmless

| Command string                | Guard behavior                     | Acceptable?                                                                                                       |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `jj git export`               | ALLOW — program resolves to `jj`   | Yes, if §2 rule 3 is implemented                                                                                  |
| `echo "git commit -m x"`      | ALLOW — program is `echo`          | Yes                                                                                                               |
| `grep -rn "git status" docs/` | ALLOW — program is `grep`          | Yes                                                                                                               |
| `cat .git/config`             | ALLOW — program is `cat`           | Yes; a substring scan would deny this                                                                             |
| `jj log -r 'git_head()'`      | ALLOW — program is `jj`            | Yes                                                                                                               |
| `npm run git:check`           | ALLOW — program is `npm`           | Yes                                                                                                               |
| `git-lfs pull`                | ALLOW — basename `git-lfs` ≠ `git` | Yes, and correct: it is a different binary                                                                        |
| `rm -rf .git`                 | ALLOW — not a Git command          | **No.** This destroys a colocated repo. Out of scope for a Git-verb guard; needs a separate destructive-path rule |

### False negatives — the guard would ALLOW but a Git command really runs

All of the following were executed and did invoke Git:

| Command string                                                    | Guard behavior                               | Acceptable?                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command git status`                                              | DENY if `command` is stripped                | Yes, with §2 rule 2                                                                                                                                                  |
| `env FOO=1 git push`                                              | DENY if the assignment is stripped           | Yes                                                                                                                                                                  |
| `sh -c 'git commit'` / `bash -lc 'git commit'`                    | DENY if `-c` bodies are recursed into        | Yes, with recursion                                                                                                                                                  |
| `eval 'git status'`                                               | DENY via recursion                           | Yes                                                                                                                                                                  |
| `nohup git --version`                                             | DENY if `nohup` is stripped                  | Yes                                                                                                                                                                  |
| `/usr/bin/git status`                                             | DENY — basename is `git`                     | Yes. Note two gits exist here: `/opt/homebrew/bin/git` (2.56.0) and `/usr/bin/git` (Apple Git-157)                                                                   |
| `echo "v=$(git rev-parse HEAD)"`                                  | DENY only via `$()` recursion                | Partially; **inconsistent** — a guard that recurses into substitutions will also flag read-only introspection. Prefer denying it (self-correcting to `jj log -r @-`) |
| ``echo "v=`git rev-parse HEAD`"``                                 | same as above                                | same                                                                                                                                                                 |
| `make commit` (Makefile target shells out to `git commit`)        | ALLOW — the string contains no `git`         | **No, and unfixable at this layer.** The guard cannot read the Makefile                                                                                              |
| `./scripts/commit.sh`                                             | ALLOW                                        | **No, unfixable**                                                                                                                                                    |
| `g=git; $g status`                                                | ALLOW                                        | **No, unfixable** — variable indirection                                                                                                                             |
| `python -c "import subprocess; subprocess.run(['git','status'])"` | ALLOW                                        | **No, unfixable**                                                                                                                                                    |
| `alias gs='git status'; gs`                                       | ALLOW                                        | **No, unfixable** — alias expansion happens inside the shell                                                                                                         |
| `echo hi \| xargs git add`                                        | ALLOW unless `xargs` is treated as a wrapper | Prefer ALLOW: treating `xargs` as a wrapper creates false positives on `xargs rm`, and `git add` is a no-op gesture anyway                                           |

### Conclusion for the guard

Implement rules 1–4 of §2 (splitting, wrapper stripping, `-c`/`eval` recursion,
substitution recursion) and accept the remaining false negatives. The
unfixable set is dominated by _indirect_ invocations, which are rare in agent
tool calls — the model emits `git commit`, not `make commit`, when it means to
commit. A guard that also denied `rm -rf .git` and Makefile/script entry points
would need filesystem and process inspection, which is a different feature.

## 5. `jj-hunk` gestures

`git add -p` maps to `jj-hunk split | commit | squash`. All three accept
`--query '<hunkset expression>'` (`jj-hunk <sub> --help`) and `-r <rev>` where
meaningful; `commit` takes a message as a positional after the selection.

### Query language (verified by execution, not by reading)

| Element               | Verified behavior                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Predicates            | `added()`, `removed()`, `changed()`, `renamed()`, `mode_changed()`, `binary_changed()`, `all()`, `none()`, `id("hunk-…")`                                                         |
| Fields                | `content:` and `path:` are the two that work. `file:` parses but **never matches anything** (returned 0 hunks for `file:"*"`, `file:glob:"*"`, `file:regex:".*"`) — do not use it |
| Value modifiers       | `substring:` (default for `content`), `glob:`, `regex:`, `exact:`. `contains:`, `icontains:`, `starts_with:` are rejected: `unknown field`                                        |
| `path:` default       | **glob**, not substring. `path:"*"` matched only top-level files; `path:"server.js"` matched nothing while `path:"**/server.js"` matched                                          |
| `content:` default    | substring, case-sensitive: `content:"timeout"` missed `TIMEOUT_MS`; `content:regex:"TIMEOUT\|timeout"` and `content:regex:"(?i)todo"` both work                                   |
| Combinators           | `\|`, `&`, `~`, parentheses                                                                                                                                                       |
| `--query` exclusivity | cannot be combined with `--files`, `--include`, or `--exclude` (all three error). File scoping must go inside the query as `path:`                                                |

### Hunk IDs regenerate — always prefer `--query`

Demonstrated directly. A single unrelated new file regenerated an untouched
hunk's ID:

```
$ jj-hunk list --format text          # after editing f.txt only
M f.txt
  hunk 0 replace hunk-d782334f9f0c228a4e07ffdcd055b3d68a9e101d8d373539576a3bd10cef525b

$ printf 'x\n' > g.txt                # unrelated new file
$ jj-hunk list --format text
M f.txt
  hunk 0 replace hunk-49b3da28caad65e73a925fd5c4045e9dbe507e322185d81ef123b99ed6266434
A g.txt
  hunk 0 insert hunk-39536b4fbdde57f74f80db8e452ae6eacf5c8b8afcd62ac035b30b54a6f02ce8
```

Worse: writing a spec file **into the repo working copy** invalidates the IDs
it contains, so the spec can never match. This was observed live — a spec saved
at `<repo>/spec.yaml` made `jj-hunk commit --spec-file spec.yaml` create an
_empty_ commit. The same spec at `/tmp/spec.yaml` worked. **Spec files must live
outside the working copy.** Recommend `--query` for anything an agent does in
one turn; use `--spec-file` only for a human-reviewed, out-of-tree artifact.

### Tested examples

All run in a scratch repo with `src/server.js` (a `TIMEOUT_MS` constant plus a
`console.log("timeout " + TIMEOUT_MS)` line), a gutted `src/legacy.js`, and a
README edit.

| #   | Agent intent                       | Command                                                                                             | Result                                                                               |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Preview before applying            | `jj-hunk list --query 'added(content:"TIMEOUT_MS")' --format text`                                  | listed 2 hunks in `src/server.js`                                                    |
| 2   | Commit only the new constant       | `jj-hunk commit --query 'added(content:"TIMEOUT_MS")' "add request timeout"`                        | created `add request timeout`; leftover `jj diff --stat` showed only `src/legacy.js` |
| 3   | Split out one file's work          | `jj-hunk split --query 'added(path:"src/server.js")' "server work"`                                 | `Selected changes: … server work` + `Remaining changes: …`                           |
| 4   | Squash debug noise into the parent | `jj-hunk squash --query 'added(content:glob:"*console.log*")'`                                      | `Rebased 1 descendant commits.`; the console.log hunks left the working copy         |
| 5   | Commit all deletions               | `jj-hunk commit --query 'removed()' "drop dead code"`                                               | committed the `legacy.js` removal and the README rewrite; inserts stayed             |
| 6   | Narrow by file **and** content     | `jj-hunk commit --query 'added(path:"src/server.js") & added(content:"TIMEOUT_MS")' "timeout only"` | committed 1 hunk; `src/legacy.js` and `README.md` stayed                             |
| 7   | Case-insensitive TODO sweep        | `jj-hunk list --query 'added(content:regex:"(?i)todo\|fixme")' --format text`                       | matched the README hunk                                                              |

### ID-based fallback, if a spec is unavoidable

```
$ jj-hunk list --spec-template --format yaml
files:
  f.txt:
    ids:
    - hunk-49b3da28caad65e73a925fd5c4045e9dbe507e322185d81ef123b99ed6266434
  g.txt:
    ids:
    - hunk-39536b4fbdde57f74f80db8e452ae6eacf5c8b8afcd62ac035b30b54a6f02ce8
default: reset
```

Write it outside the repo, edit `ids`, then
`jj-hunk commit --spec-file /tmp/spec.yaml "msg"` (verified end to end:
`jj-hunk list --spec-file /tmp/spec.yaml --format text` previewed exactly the
selected hunk, and the commit left the other file in the working copy).

### Settled since

Each of these was UNVERIFIED here and has now been exercised against
`jj-hunk 0.5.1`, built from `github.com/laulauland/jj-hunk` at tag `v0.5.1`.

- **`--query` and `--spec-file` are mutually exclusive — VERIFIED.** Not merely
  "the help text presents them as alternatives": combining them is an error, and
  the error names both. `error: the argument '--query <QUERY>' cannot be used with
  '--spec-file <SPEC_FILE>'`. A bridge that builds both will fail.
- **`jj-hunk select` is not agent-facing — VERIFIED.** Its usage is
  `select [OPTIONS] <LEFT> <RIGHT>`, and its own description is "called by
  `jj --tool`". It is the `jj split -i` integration path, and the bridge does not
  use it.
- **`renamed()`, `mode_changed()` and `binary_changed()` select a file and yield
  no hunks — VERIFIED, with a caveat worth keeping.** On a repository that really
  contains all three — a rename, `chmod +x`, and 64 bytes of random data — each
  query returns **1 file and 0 hunks**:

  ```
  renamed()        -> 1 file(s), 0 hunk(s)
  mode_changed()   -> 1 file(s), 0 hunk(s)
  binary_changed() -> 1 file(s), 0 hunk(s)
  ```

  So the earlier note was right to distrust "0 hunks on a text-only fixture", and
  the answer is not what a positive test would have suggested either. The
  functions work — the _file_ is selected — but a rename, a mode change and a
  binary change have no text hunks to report. A caller that treats "0 hunks" as
  "nothing to do" is correct; a caller that treats it as "the query failed" is
  not, and `jj_hunk_apply` with one of these selections would have nothing to
  apply.

## 6. Static translation of the actual arguments

§1 maps a _gesture_ to a `jj` verb. It says nothing about the arguments, so the
denial for `git log --oneline -6` used to be the denial for `git log` — and the
model was left to work out that `--oneline` is `--no-graph`, that `-6` is
`--limit 6`, and that `HEAD` is not a revset. `src/translate.ts` does that
analysis and the guard composes the result into the reason
([25](25-prompt-copy.md) §2.4).

**Every emitted command was executed against `jj` 0.46 before being documented.**
That is not ceremony: `HEAD` is not a `jj` revset, so a translation that passed a
Git revision through produces a command that fails on the user's next call.

### 6.1 Revisions — the one thing that must never pass through

| Git               | `jj`              | Evidence                                                         |
| ----------------- | ----------------- | ---------------------------------------------------------------- |
| `HEAD`            | `@`               | `jj log -r HEAD` → `Error: Revision 'HEAD' doesn't exist`        |
| `HEAD~N`          | `@` + N × `-`     | `jj log -r HEAD~1` → the same error                              |
| `HEAD^`, `HEAD^1` | `@-`              | same                                                             |
| `HEAD^2`          | _none_            | revsets have no positional parent selector; translation withheld |
| `main`, `<sha>`   | unchanged         | already a valid revset atom                                      |
| `A..B` (log)      | `-r A..B`         | unchanged                                                        |
| `A..B` (diff)     | `--from A --to B` | `jj diff` takes the two ends as flags                            |

### 6.2 Flags that do not survive the rename

| Git                   | `jj`                      | Note                                                       |
| --------------------- | ------------------------- | ---------------------------------------------------------- |
| `log --oneline`       | `log --no-graph`          | one revision per line                                      |
| `log -6`, `-n 6`      | `log --limit 6`           |                                                            |
| `log` (bare)          | `log -r '::@'`            | bare `jj log` shows `revsets.log`, not the ancestry of `@` |
| `log --all`           | `log -r 'all()'`          |                                                            |
| `diff` (one rev)      | `diff --from <rev>`       | `jj diff -r <rev>` also exists but means "vs its parent"   |
| `diff A B`            | `diff --from A --to B`    |                                                            |
| `diff --staged`       | _none_                    | no index to diff against                                   |
| `status --porcelain`  | _none_                    | no porcelain mode; translation withheld                    |
| `push --force`        | dropped                   | `jj git push` is already force-with-lease                  |
| `push <remote> <bm>`  | `--remote`, `--bookmark`  |                                                            |
| `fetch <remote>`      | `fetch --remote <remote>` |                                                            |
| `restore --source`    | `restore --from`          |                                                            |
| `reset --soft`        | `squash --from`           | "uncommit, keep the changes"                               |
| `checkout -- <paths>` | `restore <paths>`         |                                                            |
| `-C <dir>`            | `-R <dir>`                | and the subcommand is translated too                       |

### 6.3 Why it is all-or-nothing for mutating verbs

`git log --since=2d` translating to `jj log -r ::@` is acceptable: the model gets
broader output than it asked for, sees that, and narrows. `git commit --amend`
translating to `jj commit` is not acceptable: the model is told its command was
understood when what it actually asked for — rewording the current change — was
silently dropped, and it will now create a new change instead.

So a mutating verb translates only when **every** argument is accounted for, and
otherwise returns `undefined`, which sends the catalogue wording from
[25](25-prompt-copy.md) §2.1 instead. Read-only verbs are best-effort by design
(§6.2's "dropped" rows). The `translate.ts` coverage test enumerates every verb
the catalogue refuses and requires each one to be either translated or named in
an explicit "cannot be translated, and here is why" list — so a new catalogue row
cannot silently have no translation.

### 6.4 What remains untranslatable

| Gesture         | Why                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `git add`       | no staging area; there is nothing to translate to                       |
| `git rebase`    | Git's branch model supplies `-s`/`-o`; `jj` needs them named explicitly |
| `git pull`      | two commands, the second conditional (`jj git fetch`, then `jj rebase`) |
| `git submodule` | no `jj` submodule command; submodules themselves are unaffected         |
| `git bisect`    | `jj bisect run` requires a `--range` that `git bisect` infers           |
| `git clean -fd` | no untracked state                                                      |
| `git lfs`       | no LFS integration                                                      |
