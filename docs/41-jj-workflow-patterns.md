# 41 — Jujutsu in the agent workflow: patterns that survived contact

**Status:** measured, 2026-11-28. Every rule below was learned by getting it
wrong in a real session on this repository, then re-running the corrected form
against the installed `jj`. The failure that produced each rule is quoted, so a
reader can tell a rule that was paid for from one that was guessed at.

This is the document the `jujutsu` skill card is distilled from. The card
carries the six rules a model needs before it types a `jj` command; this carries
the reasoning and the evidence, for whoever maintains the card.

---

## 1. A commit message is data, and a double-quoted shell argument is not

**What happened.** A commit message containing backticks was passed inline:

```sh
jj commit -m "fix(guard): close the nested .git/.jj hole ...
`rm -rf .git/objects` and `rm -rf .jj/repo` were allowed ..."
```

The shell ran `rm -rf .git/objects` as a command substitution before `jj` ever
saw the message. The command printed `bash: line 34: exist: command not found`,
`jj` received a mangled message, and `jj commit` — which takes trailing
positional arguments as paths — failed with `Warning: The given paths do not
match any file: not` and committed nothing. The commit that was supposed to
carry the message was skipped entirely, and the working copy was left looking
as though the command had succeeded.

**The rules.**

1. **Inside this harness, pass the message as a tool parameter.** `jj_commit`,
   `jj_describe` and `jj_hunk_apply` take `message` as a JSON string and quote
   it once, at the argv edge, with `shellQuote`. That path cannot interpolate.
2. **When bash is unavoidable, single-quote the message** (`-m '…'`), or write it
   to a file and use `jj describe --stdin < file`. Neither `jj commit` nor
   `jj describe` has a `--message-file`; `--stdin` is `jj describe`'s form
   (verified with `jj commit --help` and `jj describe --help`, 0.47.0).
3. **A command that quotes correctly still has a second hazard: trailing
   positionals.** `jj commit` (and `jj describe -m` followed by words) reads
   non-flag arguments as paths. A mangled message therefore does not fail
   cleanly — it takes the last word as a path and warns. Check `jj status`
   after any `jj commit` that was composed in a shell.

**Why it matters to an agent specifically.** The failure is silent in the
direction that hurts: the commit is not created, the exit code is 0, and the
next command sees a working copy that still contains everything. An agent that
trusts the exit code reports work that does not exist. Verify with
`jj log -r @- --limit 1` or `jj status`, never with the exit code alone.

## 2. The commit type is a release decision, not a label

`dsh-jujutsu` releases through release-please, which reads conventional commits
since the last tag. The type therefore chooses the version:

| Type                          | Release                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `fix:`                        | patch (`0.4.0` → `0.4.1`)                                    |
| `feat:`                       | minor (`0.4.0` → `0.5.0`)                                    |
| `feat!:` / `BREAKING CHANGE:` | major — capped by `bump-minor-pre-major` while below `1.0.0` |

**What happened.** A display-and-docs change was committed as
`feat(display): …`. release-please opened **release 0.5.0**. The change added no
capability, so the version was wrong; rewriting the message to
`fix(display): …` produced **0.4.1**, which is what shipped.

**The rules.**

1. Choose the type by what the user receives, not by the size of the diff. A
   docs, copy or packaging change is `fix:` or `chore:`, never `feat:`.
2. Fix the type **before pushing** — while the commit is still mutable, it is a
   one-line `jj describe`. After the release PR is merged it is a history
   rewrite plus a new tag.
3. When a release PR proposes a version that does not match the change, close
   the PR rather than merging it and following up: the bump is already baked
   into the tag and the changelog.

## 3. Rewriting published history is a flag, not an accident

`jj` refuses to rewrite any commit in `immutable_heads()`, which on a colocated
checkout means the remote's trunk. The refusal is exact:

```
Error: Commit f791bde59fdf is immutable
Hint: Immutable commits are used to protect shared history.
Hint: This operation would rewrite 1 immutable commits.
```

**The rules.**

1. **Prefer rewriting before the push.** `jj describe -m …` on a local commit is
   free; the same operation on `main@origin` needs a deliberate escape hatch.
2. **The tool surface now carries that escape hatch as a parameter**, not as a
   hidden flag: `jj_describe({allowImmutable:true})`,
   `jj_squash({allowImmutable:true})` and `jj_history({allowImmutable:true})`
   pass `--ignore-immutable`. Omit it and the call fails with
   `JJ_COMMIT_IMMUTABLE` and a hint naming the parameter, instead of the
   useless "run it by hand to see the full output".
3. **The root commit is not that case.** A revset that resolves to root reports
   `The root commit 000000000000 is immutable`; `--ignore-immutable` is not the
   answer there, and the tool says so.

## 4. A push after a rewrite is still a safe push

Rewriting a local commit under a bookmark that is already on the remote makes
the push a sideways move:

```
$ jj git push --bookmark main
Changes to push to origin:
  bookmark: main [move sideways from 05e4372e6b06 to 08fdfc468000]
```

There is no `--force`. `jj git push` compares against the last fetch and refuses
if the remote moved underneath — the same guarantee as
`--force-with-lease`, without the chance of typing the wrong one.

**The rule.** "I need to force-push" is never a reason to reach for `git`. The
jj push that follows a rewrite is already the safe form; the only thing to check
is that the remote has not moved since the fetch.

## 5. The sync-and-release loop, in order

This is the exact sequence that released `0.4.0`, `0.4.1` and `0.4.2` here.
`jj` has no `pull`, and the working copy is a commit, so the loop has two
distinct steps that Git does in one:

```sh
jj git fetch                 # get the remote's commits and bookmarks
jj new main                  # start an empty change on top of the new main
jj bookmark set main -r @-   # nothing to do if main already moved; see below
jj git push --bookmark main  # publish the commit(s) you just finished
```

- **`jj new main` is the `git pull` half.** It moves `@` onto `main@origin` —
  but the local `main` bookmark does **not** follow automatically. That is the
  one thing that surprises a Git user: after `jj new main`, `@-` is the new main
  tip and the bookmark may still point at the old one.
- **`jj bookmark set main -r <rev>`** is how the bookmark is moved, and it is
  what makes the push a fast-forward rather than a sideways move.
- **Verify before pushing**: `jj log -r 'main | @'` shows both, and
  `jj diff -r @- --stat` shows what the commit under the bookmark actually
  contains. After an accidental empty commit, `jj diff -r @-` reports nothing
  and the push has nothing to send.

## 6. The operation log is the undo, and it is cheap to use

Every mutation above is reversible: `jj op log` lists the operations,
`jj op restore <op-id>` returns the whole repository to that point, and
`jj undo` reverts the last one. A session out of its depth should restore the
checkpoint it started from rather than reason about the current state.

**What that costs.** Nothing but the local replay: the op log is a local
structure, `jj op restore` does not touch the remote, and a restore of a
local-only mistake cannot corrupt anything. The one thing it does not protect is
deleting `.git` or `.jj` — which is why the guard refuses that separately.

---

## The six rules, as the skill card states them

1. Pass a message as a parameter; in bash, single-quote it or use
   `jj describe --stdin`.
2. The commit type picks the release version; choose it deliberately and change
   it before pushing.
3. Rewriting shared history needs a deliberate flag — `allowImmutable` — and
   the root commit is never the target.
4. A push after a rewrite is already the safe push; there is no `--force`.
5. `jj git fetch` then `jj new main`; the bookmark does not follow by itself.
6. `jj op log` / `jj op restore` is the undo, and it never touches the remote.

## What is measured, and how

| Claim                                                                          | Evidence                                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The backtick substitution mangles a `-m` message and silently skips the commit | Reproduced in this repository: the command printed `bash: line 34: exist: command not found`, then `Warning: The given paths do not match any file: not` |
| `git`-style types map to release-please bumps                                  | `feat(display)` opened release 0.5.0 (PR #15 on `viztor/dsh-jujutsu`); reworded to `fix(display)`, it opened 0.4.1                                       |
| The immutable refusal text                                                     | `jj describe -r @- -m x` against a tracked `main@origin`, on the installed `jj` (0.47 line)                                                              |
| `jj commit` reads trailing words as paths                                      | The same failure: `Warning: The given paths do not match any file`                                                                                       |
| The sideways push                                                              | `jj git push --bookmark main` after rewriting `05e4372`                                                                                                  |
| `jj new` does not move the bookmark                                            | `jj status` after `jj new main`: `@-` was the new tip while `main` still named the old commit                                                            |
