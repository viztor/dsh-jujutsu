# 25 — Prompt copy

The model-facing copy, final and paste-ready: the two injected texts, the denial
catalogue, the tool descriptions, and the phrases to avoid.

Sources of truth, not restated here: [22](22-context-injection.md) (injection
mechanism, budget, template pattern), [15](15-verb-mapping.md) §1 (Git→`jj`
table), [14](14-decision-log.md) R1–R10, [18](18-tool-surface.md) (tools),
[17](17-bypass-and-approval.md) (`displayReason`, ask/deny matrix),
[`SPEC.md` §5.7](../SPEC.md) (destructive-path predicate).

## Copy rules

These bind every string in this file.

| #   | Rule                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Name the exact command.** A denial that does not tell the model what to run instead has failed.                                                                                                                                                                   |
| 2   | **≤240 characters** per message. Every length is stated.                                                                                                                                                                                                            |
| 3   | **No scolding, no "I'm sorry", no exclamation marks.** It is a tool result, not a conversation.                                                                                                                                                                     |
| 4   | **Deterministic.** The same command always produces the same string; no timestamps, versions, or hedging.                                                                                                                                                           |
| 5   | **Never mention the plugin, the user's settings, or "policy".** The model needs the fact and the remedy.                                                                                                                                                            |
| 6   | **No invented equivalents.** Where a Git gesture has no `jj` command (`git submodule`, `git lfs`, `git clean -fd`), say so plainly and name the outside-the-workspace route.                                                                                        |
| 7   | **`Refused:` prefix** on hard denies (all verb rows, the fallback, write-protection). The ask-class strings — destructive path, unresolvable path, low confidence — open with the fact instead, because the same string is the `ask` reason before a human answers. |
| 8   | Dynamic slots in the injected texts are `{{…}}`; per-call values inside messages are `<angle-bracketed>`. Nothing machine-specific is baked in.                                                                                                                     |

---

## 1. The two injected texts

Registration shape and ordering come from [22](22-context-injection.md) §5:
`jujutsu:bash-policy` is a `systemPrompt.section` at `TOOL_BASH` (1000);
`jujutsu:workspace` is a `systemPrompt.context` at order 130. Both `text`
functions return `""` outside a `jj` workspace, so the cost is zero elsewhere.

### 1.1 System section — `jujutsu:bash-policy`

```text
Version control here is Jujutsu (jj). The bash tool intercepts git and returns the
jj command to run instead; there is no Git mode. Use jj for every version-control
step. The working copy @ is always a commit and always dirty: no staging, nothing
to add. Address revisions by change ID, which survives rewrites; commit IDs do not.
Bookmarks are the publish boundary: jj git push --bookmark <name>.
```

### 1.2 Runtime context — `jujutsu:workspace`

```text
Workspace root: {{root}}
Layout: {{colocated with Git | native jj, no .git}}
Working copy @: {{change_id}}
Hunk selection: {{jj-hunk available | jj-hunk not installed, hunk tools unavailable}}
```

`{{a | b}}` means "substitute one of the alternatives"; the braces are not
emitted.

| Placeholder                                                              | Source                                          | Values                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------ |
| `{{root}}`                                                               | `agent.session.header.cwd`                      | the absolute workspace root                      |
| `{{colocated with Git \| native jj, no .git}}`                           | the detector (`jj`/`jj-colocated`)              | pick one                                         |
| `{{change_id}}`                                                          | `jj log --no-graph -T 'change_id.short()' -r @` | short change ID, e.g. `nsosovxq`                 |
| `{{jj-hunk available \| jj-hunk not installed, hunk tools unavailable}}` | `jj-hunk --version` probe                       | pick one; may carry the resolved `~/`-based path |

### 1.3 Rendered example

Real output values from a scratch **colocated** workspace (`jj git init`, one
commit, one edit):

```text
Workspace root: /tmp/jujutsu-prompt
Layout: colocated with Git (.git and .jj both present)
Working copy @: nsosovxq
Hunk selection: jj-hunk 0.5.1 available
```

### 1.4 Word count

Budget from [22](22-context-injection.md) §6: **~200 words combined**. Counted
with each `{{…}}` group as one word.

| Text                            | Words  |
| ------------------------------- | ------ |
| System section (1.1)            | 68     |
| Runtime context, template (1.2) | 12     |
| **Combined template**           | **80** |
| Runtime context, rendered (1.3) | 21     |
| Combined rendered               | 89     |

Both figures are under budget. The detail lives in the tool descriptions
(§3), never here.

---

## 2. Denial message catalogue

50 strings: 43 verb rows from [15](15-verb-mapping.md) §1 (39 DENY + 4
SPECIAL), the R3–R5 generic fallback, 3 destructive-path strings, 2
write-protection strings, and 1 low-confidence string. Lengths exclude the
surrounding backticks.

Ask/deny posture per [17](17-bypass-and-approval.md): verb rows, the fallback,
and destructive paths are `ask` under policy `ask` and `deny` with the same
reason under `never`; write-protection is a hard `deny` in both; low confidence
asks and is never allowed.

### 2.1 Verb-mapping denials (43 rows)

| Git command                | Message                                                                                                                                                           | Chars |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `git status`               | Refused: git status describes a Git working tree that does not exist here. Run: jj status                                                                         | 89    |
| `git diff`                 | Refused: git diff. Jujutsu has no staging index. Run: jj diff for the working-copy change, or jj diff -r <rev> for another revision.                              | 132   |
| `git log`                  | Refused: git log. Run: jj log. Use jj log -r '::@' for ancestors of @, or jj log -r 'all()' for everything reachable.                                             | 117   |
| `git add <path>`           | Refused: git add. Jujutsu has no staging area and tracks new files automatically. Run: jj status or jj diff to see the change.                                    | 126   |
| `git add -p`               | Refused: git add -p. There is no index to stage into. For hunk selection run: jj-hunk commit --query '<hunkset>' "msg" (split and squash also work).              | 148   |
| `git commit`               | Refused: git commit. Run: jj commit -m "<msg>". The working copy @ is already a commit; this finalizes it and starts a new empty change on top.                   | 143   |
| `git commit --amend`       | Refused: git commit --amend; --amend does not exist. Run: jj describe -m "<msg>" to reword, or jj squash to fold edits into the parent.                           | 135   |
| `git commit -m "msg"`      | Refused: git commit -m. Run: jj commit -m "<msg>".                                                                                                                | 50    |
| `git branch`               | Refused: git branch. Jujutsu calls branches bookmarks. Run: jj bookmark list (alias jj b l).                                                                      | 92    |
| `git branch -a`            | Refused: git branch -a. Run: jj bookmark list --all-remotes to include remote-tracking bookmarks.                                                                 | 97    |
| `git branch <name>`        | Refused: git branch <name>. Run: jj bookmark create <name> -r <rev>.                                                                                              | 68    |
| `git branch -d <name>`     | Refused: git branch -d. Run: jj bookmark delete <name>.                                                                                                           | 55    |
| `git checkout -b <name>`   | Refused: git checkout -b. Run: jj new to start a change, then jj bookmark create <name> -r @-. Jujutsu has no branch-switch step.                                 | 129   |
| `git checkout <branch>`    | Refused: git checkout. Run: jj new <rev> to start a change on top of it, or jj edit <rev> to make it the working copy.                                            | 118   |
| `git switch <branch>`      | Refused: git switch. Run: jj new <rev> to start a change on top, or jj edit <rev> to make that revision the working copy.                                         | 121   |
| `git merge <rev>`          | Refused: git merge. Run: jj new @ <rev>. A merge is a change with two parents; conflicts are recorded in-tree, so there is no --continue.                         | 137   |
| `git rebase`               | Refused: git rebase. Run: jj rebase -s <src> -o <dest> to move a subtree, or jj rebase -b <bookmark> -o <dest> to move a branch.                                  | 128   |
| `git rebase -i`            | Refused: git rebase -i; it is interactive and cannot run headless. Run: jj rebase -r <rev> -B <rev> to reorder, jj squash to fold, jj absorb to auto-place fixes. | 167   |
| `git reset --hard`         | Refused: git reset --hard. Discard edits with jj restore <paths>, or drop the current change with jj abandon. Both are reversible with jj undo.                   | 143   |
| `git reset --soft HEAD~1`  | Refused: git reset --soft. Run: jj squash --from @- to fold the parent diff into the working copy. Jujutsu never rewrites a commit in place.                      | 140   |
| `git stash`                | Refused: git stash; Jujutsu has no stash. Run: jj new @- to park the current change as a sibling commit; find it later with jj log.                               | 131   |
| `git stash pop`            | Refused: git stash pop; there is no stash to pop. Re-enter the parked change with jj edit <change-id> (locate it with jj log).                                    | 126   |
| `git cherry-pick <rev>`    | Refused: git cherry-pick. Run: jj duplicate <rev> -o <dest> to copy that change onto another commit.                                                              | 100   |
| `git revert <rev>`         | Refused: git revert. Run: jj revert -r <rev> -B @ to insert the inverse of <rev> just before the working copy.                                                    | 110   |
| `git tag`                  | Refused: git tag. Run: jj tag list, jj tag set <name> -r <rev>, or jj tag delete <name>.                                                                          | 88    |
| `git push`                 | Refused: git push. Run: jj git push --bookmark <name>. Jujutsu pushes bookmarks explicitly; there is no implicit current-branch push.                             | 133   |
| `git push --force`         | Refused: git push --force; no force flag is needed. jj git push updates the remote only if it matches what you last fetched.                                      | 124   |
| `git pull`                 | Refused: git pull; Jujutsu has no pull. Run: jj git fetch, then jj rebase -b <bookmark> -o <remote-bookmark> to integrate.                                        | 122   |
| `git fetch`                | Refused: git fetch. Run: jj git fetch. The jj prefix matters: jj git fetch is a Jujutsu command and is never refused.                                             | 117   |
| `git clone <url>`          | Refused: git clone. Run: jj git clone <url> [<dir>]; it creates a colocated repo by default.                                                                      | 92    |
| `git remote -v`            | Refused: git remote -v. Run: jj git remote list; add one with jj git remote add <name> <url>.                                                                     | 93    |
| `git remote add <n> <url>` | Refused: git remote add. Run: jj git remote add <name> <url>.                                                                                                     | 61    |
| `git worktree add <path>`  | Refused: git worktree add. Run: jj workspace add <path>. Workspaces are Jujutsu's native multi-working-copy feature.                                              | 116   |
| `git bisect`               | Refused: git bisect. Run: jj bisect run <cmd>; it finds the first bad revision automatically.                                                                     | 93    |
| `git blame <file>`         | Refused: git blame. Run: jj file annotate <path> to show the change that last modified each line.                                                                 | 97    |
| `git show <rev>`           | Refused: git show. Run: jj show <rev> for the description plus diff.                                                                                              | 68    |
| `git restore <path>`       | Refused: git restore. Run: jj restore <paths> to restore from the parent, or jj restore --from <rev> <paths>.                                                     | 109   |
| `git init`                 | Refused: git init. This is already a Jujutsu workspace; there is nothing to initialise. To create a new Jujutsu repo elsewhere, run: jj git init <directory>.     | 157   |
| `git -C <dir> <sub>`       | Refused: git -C <dir>. Run: jj -R <dir> <sub>, or cd <dir> first.                                                                                                 | 65    |
| `git submodule`            | Refused: git submodule; Jujutsu has no submodule support. If the task truly needs submodules, use a separate plain Git clone outside this workspace.              | 148   |
| `git clean -fd`            | Refused: git clean -fd; Jujutsu has no untracked state to clean. Inspect with jj status, then delete the files yourself with rm.                                  | 128   |
| `git config`               | Refused: git config; Jujutsu reads identity from its own config, not .git/config. Run: jj config set --user user.name "<name>", or jj config list.                | 146   |
| `git lfs`                  | Refused: git lfs; Jujutsu has no LFS integration and the git binary fronts this subcommand. Fetch LFS objects with a plain Git checkout outside this workspace.   | 159   |

`git init` carries the R7 correction verbatim in substance: it must **not** tell
the model to run `jj git init` in place, because that exits 1 with
`Error: The target repo already exists`. It redirects to a new directory.

### 2.2 Fallback, destructive paths, write-protection, low confidence (7 rows)

| Case                                                                                             | Message                                                                                                                                                                                                                                    | Chars |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| R3–R5 generic fallback (bare `git`, `git --version`, unknown subcommand)                         | Refused: this is a Jujutsu workspace and git is not used here. Run: jj help for the command list, or jj log for history with change IDs.                                                                                                   | 136   |
| Destructive verb on exact component `.git` (SPEC §5.7)                                           | Refused: this deletes .git, which is where Jujutsu keeps its commit objects — so it destroys the history, not just the Git plumbing, and jj cannot restore it. If you meant to stop using Git here, run jj git colocation disable instead. | 234   |
| Destructive verb on exact component `.jj` (SPEC §5.7)                                            | Refused: this deletes .jj, which holds the operation log — the record every jj undo depends on. Without it nothing is recoverable. To get back to a good state use jj op restore <opId> (list them with jj op log).                        | 211   |
| Destructive verb, path contains an expansion (`"$PWD/.git"`) — ask, never allow                  | Refused: this deletes a computed path that resolves to .git or .jj. It cannot be checked before the command runs, and both are unrecoverable — .git holds Jujutsu's commits, .jj its operation log. Use a literal path if you mean it.     | 230   |
| `write`/`edit` into `.jj/**`                                                                     | Refused: writing inside .jj corrupts the operation log and working-copy state. Read is allowed. To undo a bad operation run: jj op restore <opId> (list operations with jj op log).                                                        | 179   |
| `write`/`edit` into `.git/**`                                                                    | Refused: writing inside .git corrupts the Git backend Jujutsu reads. Read is allowed. To undo a bad operation run: jj op restore <opId> (list operations with jj op log).                                                                  | 169   |
| Low confidence: program unresolved (indirect, computed, interpreter inline) — asks, never allows | This invocation cannot be resolved confidently (indirect or computed program). If it runs Git, replace it with the jj equivalent (run jj help). Otherwise re-run it with the program named literally.                                      | 197   |

`read` into `.jj/**` or `.git/**` is allowed and produces no message
([14](14-decision-log.md) D6). Exact-component matching keeps `.gitignore`,
`.gitattributes`, `.gitkeep` and `.github/` out of the destructive predicate.

**The three destructive rows were corrected to the shipped copy.** They were the
only rows in this table without the `Refused:` prefix that every other denial
carries, and `src/messages.ts` emits `reason` verbatim as the refusal — so the
document, not the module, was the odd one out. Two further tells: the README
already described the `.git` case as "explains that `jj`'s commit objects live
there", which is this wording and not the old one, and the old rows offered `jj
workspace add <path>` as a second alternative, which the shipped copy dropped to
stay inside the 240-character budget the module asserts at load. The module's
header says the document wins; the fix for a disagreement is to correct whichever
side is stale, and here that was the document. `test/transcription.test.ts` now
checks the two against each other in both directions, so the next disagreement
fails rather than waiting to be noticed.

### 2.3 `displayReason` variants (11 rows)

The short string a human sees in the approval prompt
([17](17-bypass-and-approval.md)). It names the consequence and the `jj`
alternative; the full `reason` stays attached to the call.

| Family                                               | `displayReason`                                                                                                                          | Chars |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Read-only (`status`, `log`, `diff`, `show`, `blame`) | Run a read-only Git command in this Jujutsu workspace? The equivalent is jj status, jj log, jj diff, jj show, or jj file annotate.       | 130   |
| `commit`                                             | Run git commit? The Jujutsu equivalent is jj commit -m "<msg>".                                                                          | 63    |
| `add`                                                | Run git add? Jujutsu has no staging area; files are tracked automatically. See jj status or jj diff.                                     | 100   |
| `branch`                                             | Run a Git branch command? Jujutsu calls these bookmarks: jj bookmark list / create / delete.                                             | 92    |
| `checkout` / `switch`                                | Run a Git checkout or switch? The Jujutsu equivalents are jj new <rev> and jj edit <rev>.                                                | 89    |
| `rebase` / `merge`                                   | Run a Git rebase or merge? The Jujutsu equivalents are jj rebase and jj new @ <rev>.                                                     | 84    |
| `reset` / `restore` / `stash`                        | Run a Git reset, restore, or stash? The Jujutsu equivalents are jj restore <paths>, jj abandon, and jj new @-.                           | 110   |
| `remote` / `push` / `pull`                           | Run a Git remote command? The Jujutsu equivalents are jj git fetch and jj git push --bookmark <name>.                                    | 101   |
| Destructive `.git`/`.jj`                             | Delete the .git or .jj component? This is unrecoverable and jj cannot restore it. Approve only if you intend to destroy this repository. | 136   |
| Write into `.jj`/`.git`                              | Write inside .jj or .git? This corrupts the state Jujutsu reads. Use jj op restore <opId> instead.                                       | 98    |
| Low confidence                                       | Run a command whose program cannot be resolved? Approve only if you are sure it does not invoke Git.                                     | 100   |

### 2.4 Composed reasons — the concrete command

§2.1's strings name the replacement for a _shape_ of command. They cannot
name it for the command actually typed, so a model refused `git log
--oneline -6` was told `Run: jj log` and left to translate six flags
itself. `src/translate.ts` performs that translation statically and
composes the reason:

```text
Refused: <the invocation as typed>. Run: <the concrete jj command>
```

Ternary slots, per copy rule 8:

| Slot                        | Source                  | Example                              |
| --------------------------- | ----------------------- | ------------------------------------ |
| `<the invocation as typed>` | the resolver's fragment | `git log --oneline -6`               |
| `<the concrete jj command>` | `translateEquivalent()` | `jj log -r ::@ --limit 6 --no-graph` |

The first slot quotes as the model wrote it — `git commit -m 'fix the thing'`,
not a re-joined argv — because the model has to recognise the sentence as its
own command. A command substitution (`git log $(date)`) was expanded before
analysis, so it falls back to the re-joined argv rather than being played back
as literal text that never ran.

**§2.1 and §2.2 remain the fallback**, not dead copy: a row's string is
what the model gets whenever static analysis declines to translate. That
happens for two reasons, both deliberate (copy rule 6):

- **The gesture has no `jj` command.** `git add`, `git submodule`,
  `git lfs`, `git clean -fd`. §2.1 already says so.
- **The arguments do not map exactly.** `git status --porcelain`,
  `git commit --amend`, `git log HEAD^2`. A translation that dropped or
  guessed at an argument would be specific _and_ wrong, which is worse
  than generic and right.

Three properties the composed strings inherit from the transcription, all
tested in `test/translate.test.ts`:

| Property                                                                       | Why                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| ≤240 chars (rule 2), falling back to §2.1 when the composition would exceed it | A truncated command is un-runnable. A long path or message must not push the reason past the harness's cut.   |
| The command is always `jj`, never `jujutsu`                                    | `jujutsu` is the project, not the binary. `Run: jujutsu log` fails with `command not found`.                  |
| Revisions are rewritten, never passed through                                  | `HEAD` is not a `jj` revset (`Error: Revision 'HEAD' doesn't exist`, 0.46): `HEAD~2` → `@--`, `HEAD^` → `@-`. |

The same command, both ways:

| The model types        | §2.1–2.2 fallback                                                                         | §2.4 composed                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `git status`           | Refused: git status describes a Git working tree that does not exist here. Run: jj status | Refused: git status. Run: jj status                                             |
| `git log --oneline -6` | Refused: git log. Run: jj log. Use jj log -r '::@' for ancestors of @ …                   | Refused: git log --oneline -6. Run: jj log -r ::@ --limit 6 --no-graph          |
| `git diff HEAD~1`      | Refused: git diff. Jujutsu has no staging index. Run: jj diff …                           | Refused: git diff HEAD~1. Run: jj diff --from @-                                |
| `git push origin main` | Refused: git push. Run: jj git push --bookmark <name>. …                                  | Refused: git push origin main. Run: jj git push --remote origin --bookmark main |
| `git branch -d feat`   | Refused: git branch -d. Run: jj bookmark delete <name>.                                   | Refused: git branch -d feat. Run: jj bookmark delete feat                       |

`displayReason` (§2.3) is unaffected: a human approving an ask still sees
the family string, because the prompt is about the consequence, not the
syntax.

---

## 3. Tool descriptions

**Count reconciled:** this flagged an off-by-one in [18](18-tool-surface.md) —
its prose said "Ten tools" while its tables listed **11** names (4 reads + 5
mutations + 2 hunk). The parent has since corrected [18](18-tool-surface.md) to
eleven and added the measured token split, so the two agree. All 11 are
specified below.

Each description carries the one `jj` fact the model gets wrong for that
operation. Argument lines are one sentence; defaults are stated so the model
does not probe.

| Tool            | `description`                                                                                                                                                      | Arguments                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jj_status`     | Show the working-copy state. @ is always a commit and always dirty: an empty diff means the change is empty, not that the tree is clean. There is no staging area. | —                                                                                                                                                                                                                                                                                                               |
| `jj_log`        | List revisions with their change IDs and commit IDs. Address revisions by change ID: it survives rewrites, while the commit ID changes on every rewrite.           | `revset` — Revisions to list; default @ and its ancestors. Example: all().<br>`limit` — Maximum revisions returned; default 20.<br>`includeDiff` — Include each revision's diff in the result; default false.                                                                                                   |
| `jj_diff`       | Show changes relative to the parent. @ is the working-copy commit, so this is the uncommitted diff and there is no staging step.                                   | `revset` — Revision to diff; default @.<br>`paths` — Limit the diff to these paths.<br>`stat` — Return per-file added/removed counts instead of hunks; default false.                                                                                                                                           |
| `jj_op_log`     | List operations in the operation log. Every jj command is recorded and reversible; this is the undo history, separate from commit history.                         | `limit` — Maximum operations returned; default 20.                                                                                                                                                                                                                                                              |
| `jj_new`        | Start a new change on top of a revision. This is not a branch switch: the previous change stays committed and @ becomes the new empty change.                      | `revset` — Parent revision(s) for the new change; default @.<br>`message` — Description for the new change.                                                                                                                                                                                                     |
| `jj_describe`   | Set or edit a change description. This rewrites the commit: the change ID is unchanged, the commit ID is not.                                                      | `message` — New description.<br>`revset` — Revision to describe; default @.                                                                                                                                                                                                                                     |
| `jj_squash`     | Move changes from one commit into another. History is mutable, so this rewrites commits in place; there is no merge and no --continue.                             | `from` — Source revision; default @.<br>`into` — Destination revision; default @-.<br>`keepEmptied` — Keep the source commit even if it becomes empty; default false.                                                                                                                                           |
| `jj_bookmark`   | Manage bookmarks, Jujutsu's branches. A bookmark is a named pointer and the publish boundary; creating or moving one is local until jj git push.                   | `action` — One of list, create, move, delete, track.<br>`name` — Bookmark name; required for create, move, delete, track.<br>`revset` — Target revision; default @ for create and move.<br>`remote` — Remote name for track; omit for local bookmarks.                                                          |
| `jj_op_restore` | Restore the repository to a previous operation. This undoes rewrites, restores, and abandons since that operation; it is the recovery path for a bad jj command.   | `opId` — Operation ID from jj_op_log.                                                                                                                                                                                                                                                                           |
| `jj_hunk_list`  | Preview hunk-level changes. Hunk IDs regenerate after any edit, so select with a query and treat returned IDs as display-only.                                     | `revset` — Revision to inspect; default @.<br>`query` — Hunkset query, e.g. added(content:"x"); composes with \|, &, and ~.<br>`group` — Group results by file or by hunk; default file.                                                                                                                        |
| `jj_hunk_apply` | Apply a hunk selection as split, commit, or squash. Run jj_hunk_list with the same query first: it selects exactly what this applies.                              | `mode` — One of split, commit, squash.<br>`query` — Hunkset query; pass the same one used with jj_hunk_list.<br>`spec` — Explicit hunk-index selection; valid only against the immediately preceding list.<br>`message` — Commit message; required for commit.<br>`revset` — Revision to operate on; default @. |

### Token cost estimate

| Component                    | Chars     | ≈ tokens  |
| ---------------------------- | --------- | --------- |
| 11 descriptions              | 1,427     | 357       |
| Argument names + lines       | 1,535     | 384       |
| **Descriptions + arguments** | **2,962** | **≈ 740** |

Estimate is `chars / 4`, the standard English rule of thumb. The remaining
schema overhead — JSON types, `enum` members, `required` arrays, tool names —
is not counted here and is what carries the total to the 1,000–1,500 range
[18](18-tool-surface.md) budgets. Tiering per [18](18-tool-surface.md) §"The
schema budget" is the lever if that cost is too high; the five-tool tier drops
this text cost by roughly half.

---

## 4. What NOT to say

| Do not say                                                               | Why                                                                                                                                | Say instead                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| "Git is disabled here."                                                  | Invites probing and retrying, and it is false: `jj git …` runs Git.                                                                | `Refused: … Run: jj status`                   |
| "A shim intercepts `git`." / "We replaced the git binary."               | No shim exists (R8); it tells the model to hunt for a bypass instead of doing the work.                                            | Name the `jj` command.                        |
| "The harness is misconfigured." / "The tool failed."                     | Implies breakage; the model reports a bug or repeats the same call.                                                                | State the workspace fact and the replacement. |
| "Sorry, I can't run that." / "Please use jj."                            | Conversational filler with no remedy; burns tokens on every call.                                                                  | `Refused: <fact>. Run: <command>.`            |
| A Jujutsu tutorial (change IDs, op log, evolution, how rewriting works). | The tool descriptions already carry it; a model that reads it twice pays twice and learns once ([22](22-context-injection.md) §6). | One clause naming the command.                |
| "Use `jj` instead of `git`." with no command.                            | No remedy; the model guesses a subcommand and gets denied again.                                                                   | The exact command and flags.                  |
| "Policy forbids…" / "your settings…" / "the plugin…".                    | Not actionable; invites the model to ask the user to change configuration mid-task.                                                | The fact and the remedy only.                 |
| Absolute machine paths.                                                  | Leaks the machine and is worthless to the reader.                                                                                  | `<path>`, `<rev>`, `<dir>`, `~/`.             |
| "You may want to try…" / "Consider…".                                    | Weak and non-deterministic; rule 4 forbids it.                                                                                     | Imperative with the exact command.            |
| Version hedging ("jj 0.46 may support…").                                | Copy must be deterministic.                                                                                                        | The verified command.                         |

---

## 5. Verification

Every distinct `jj`/`jj-hunk` verb recommended above was run with
`JJ_CONFIG=/dev/null` against `jj` 0.46.0 and `jj-hunk` 0.5.1.

| Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Result                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `jj status`, `jj diff`, `jj log`, `jj show`, `jj commit`, `jj describe`, `jj squash`, `jj new`, `jj edit`, `jj abandon`, `jj restore`, `jj rebase`, `jj duplicate`, `jj revert`, `jj absorb`, `jj split`, `jj undo`, `jj tag` (`list`/`set`/`delete`), `jj bisect run`, `jj file annotate`, `jj op log`, `jj op restore`, `jj workspace add`, `jj git` (`fetch`/`push`/`clone`/`init`/`remote`/`colocation`), `jj config set --user` / `jj config list`, `jj bookmark` (`list`/`create`/`delete`/`move`/`track`), `jj -R` | all exist                                                                                           |
| Flags: `jj bookmark list --all-remotes`, `jj duplicate -o`, `jj rebase -s/-b/-r/-o`, `jj rebase -r <rev> -B <rev>`, `jj revert -r <rev> -B`, `jj squash --from/--into/--keep-emptied`, `jj restore --from`, `jj new -m`, `jj describe -m`, `jj commit -m`, `jj git push --bookmark`, `jj git init --no-colocate`, `jj -R`                                                                                                                                                                                                 | all exist                                                                                           |
| `jj-hunk list/split/commit/squash --query`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | all exist                                                                                           |
| Aliases `jj st`, `jj b l`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | confirmed                                                                                           |
| `jj rebase --before` is an undocumented alias of `-B/--insert-before`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | confirmed by execution — it is absent from `jj help rebase`, so the plugin uses the documented `-B` |
| Commands that had to be **changed** because they do not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **none**                                                                                            |
| Longest message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | destructive `.git`, **214** chars (limit 240)                                                       |
| Messages over 240 chars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **0 of 50**                                                                                         |
| Messages containing `!`, "sorry", "policy", "plugin", or a user setting                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **0**                                                                                               |

### Rows where no good message exists

| Row                  | Judgement                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git submodule`      | `jj` has no submodule support (no `submodule` token in `jj --help` or `jj git --help`). The message cannot name a `jj` command; it says so plainly and routes to a plain Git clone outside the workspace. Best available, not a `jj` remedy.                 |
| `git lfs`            | Same shape: no `jj` LFS integration, and the `git` binary fronts the subcommand so it cannot be allowed through. Routes to a plain Git checkout outside the workspace.                                                                                       |
| `git clean -fd`      | `jj` has no untracked bucket to sweep (`jj file untrack` requires the path to already match an ignore pattern, so it is not a substitute). The message names `jj status` for inspection and `rm` for the deletion, which is a filesystem act, not a VCS one. |
| `git -C <dir> <sub>` | `jj -R <dir> <sub>` is the equivalent, but the message cannot know `<sub>`; it names the pattern, which is the most a single deterministic string can do.                                                                                                    |
