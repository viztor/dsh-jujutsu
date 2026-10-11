# 13 — Empirical verification (measured, not inferred)

**Status:** everything here was executed on this machine. Each row carries the
command that produced it.

Toolchain installed for this project:

| Tool | Version | Path |
|---|---|---|
| `jj` | 0.46.0 | `/opt/homebrew/bin/jj` (Homebrew bottle) |
| `jj-hunk` | 0.5.1 | `~/.cargo/bin/jj-hunk` (`cargo install --git https://github.com/laulauland/jj-hunk jj-hunk`) |

All `jj` runs used `JJ_CONFIG=/dev/null` so no user configuration was touched.
Fixtures lived in `/tmp/jjverify*` and `/tmp/jjnocol`.

## 1. `jj git init` is colocated by default — CONFIRMED

```
$ mkdir /tmp/jjverify && cd /tmp/jjverify && jj git init
Initialized repo in "."
$ ls -a
.git  .jj
```

Both directories are created with no flags. `.jj/` contains `.gitignore`,
`repo/`, `working_copy/`. The opt-out exists and works:

```
$ jj git init --no-colocate
Initialized repo in "."
$ ls -a
.jj
```

**Consequence.** Detection cannot be "no `.git` means it is a `jj` repo". The
signal is `.jj/`; the presence of `.git/` additionally tells you the repo is
*colocated*, which is the common case. See
[03](03-project-detection.md).

## 2. Secondary workspaces: `.jj` is a directory, `.git` is a file — CORRECTED

```
$ jj workspace add ../jjverify-ws2
Created Git worktree for the new workspace.
Created workspace in "../jjverify-ws2"
$ ls -a ../jjverify-ws2
.git  .jj
$ find ../jjverify-ws2/.jj -maxdepth 2
.jj/.gitignore
.jj/working_copy/{checkout,type,tree_state}
.jj/repo
$ cat ../jjverify-ws2/.git
gitdir: ../jjverify/.git/worktrees/jjverify-ws2
```

This **contradicts an earlier claim in this repo** (docs 03 and 09 originally
said the secondary workspace's `.jj` entry is a file). It is the opposite:
`.jj/` stays a directory, and it is `.git` that becomes a file pointing at a
Git worktree.

It also **contradicts the conversation** (turn 12), which states that
`git-worktree` is unsupported by the `jj` backend. `jj` does not let you *use*
`git worktree` to manage isolation, but its own `jj workspace add` **creates a
Git worktree** in a colocated repo, as the output says.

**Consequence for detection.** `jj workspace add` produces a second working
directory whose `.jj/` is a real directory and whose `.git` is a file. A
detector that tests `isDirectory('.jj')` works in both. A detector that assumes
`.jj` is a directory at the primary root and a file elsewhere would be wrong.

## 3. `jj git export` is a no-op in colocated workspaces — IMPORTANT

```
$ jj bookmark create my-feature -r @
Created 1 bookmarks pointing to xsypwzts d5ffa2d0 my-feature | mixed changes
$ jj git export
No export needed in colocated workspaces.
$ git branch --list
* (no branch)
  my-feature
```

The bookmark is already a Git branch. There is nothing to export.

**Consequence.** [10](10-workflow-compatibility.md) recommended running
`jj git export && pnpm build` to keep Turborepo's change detection honest. In a
colocated workspace — which `jj git init` produces by default — that is
unnecessary: `jj` keeps `.git` refs current itself. The export bridge only
matters for `--no-colocate` repos. This removes one of the two reasons the
earlier draft gave for allowing Git.

## 4. Plain Git works in a colocated repo, and `git commit` desynchronises it

```
$ git status --short
 M client.rs
$ git log --oneline
835738e fix: increase timeout
0ab8def initial
$ git add -A && git commit -m "via git"
[detached HEAD 3c02384] via git
$ jj log --no-graph -T 'description.first_line() ++ "\n"'
Reset the working copy parent to the new Git HEAD.

via git
mixed changes
```

`git status` and `git log` read `jj`'s state correctly. `git commit` **succeeds**
— and leaves the repository in **detached HEAD**, after which `jj` reports that
it reset the working-copy parent to the new Git HEAD.

**Correction (independently re-verified):** the detached HEAD is **not caused by
`git commit`**. `jj` detaches it itself as soon as it takes over the working
copy:

```
$ jj git init && cat .git/HEAD
ref: refs/heads/main
$ jj commit -m "first" && cat .git/HEAD
2ce03675c798eff0c48c2b0d6ec0c08b1fc7640e
```

So the repo is already on a raw SHA before any Git command runs; `git commit`
merely advances it. The consequence is unchanged — `jj` re-parents the working
copy afterwards — but the causation in the earlier draft was wrong.

**Second correction: `git status` is stale.** Git does not trigger a `jj`
snapshot, so the two disagree on a brand-new file:

```
$ echo y > b.txt
$ git status --short
?? b.txt
$ jj status
Working copy changes:
A b.txt
```

This is a stronger argument for the guard than the detached HEAD: `git status`
does not merely omit `jj` information, it reports a *different* state than `jj`
does. A model that orients itself with `git status` in a `jj` repo is being
actively misled. See [17](17-bypass-and-approval.md) for the resulting D2
decision.

**Consequence — and this is the strongest argument for the guard.** The hazard
is not that `git commit` fails. It is that it *succeeds*, silently rewrites the
relationship between `@` and its parent, and drops the repo into detached HEAD.
An agent that then reasons about "the current branch" is reasoning about
something that no longer means what it did. Denying the call with an actionable
message is strictly better than letting it run.

## 5. `jj-hunk` works end to end — CONFIRMED

Fixture: one file, two independent one-line changes (a timeout and a log level).

```
$ jj-hunk list --format text
M client.rs
  hunk 0 replace hunk-2d5ea075...93c1b10 (before 1+1 after 1+1)
    - let timeout = Duration::from_secs(5);
    + let timeout = Duration::from_secs(30);
  hunk 1 replace hunk-2c86b480...975bd14ce (before 3+1 after 3+1)
    - log::debug!("request");
    + log::info!("request");

$ jj-hunk split --query 'added(content:"from_secs(30)")' "fix: increase timeout"
Selected changes : kkoutvzx 835738e8 fix: increase timeout
Remaining changes: xsypwzts d5ffa2d0 mixed changes

$ jj diff --stat
client.rs | 2 +-
1 file changed, 1 insertion(+), 1 deletion(-)
```

The timeout change became its own commit; the logging change stayed in the
working copy. Non-interactive, no TUI, exactly as documented. The hunkset
**query** form is the one to build on.

## 6. Hunk IDs regenerate on any edit — CONFIRMED

```
$ BEFORE=$(jj-hunk list --format text | grep -o 'hunk-[0-9a-f]\{16\}' | head -1)
before: hunk-2aafe09f0461f8cd
$ echo "// touch" >> client.rs
$ AFTER=$(...)
after:  hunk-f7f9d18f81335993
IDs CHANGED
```

Appending one comment invalidated the ID. This is the caveat the conversation
got backwards, and it is now measured.

**Consequence.** A tool surface that returns hunk IDs to the model in one turn
and accepts them in the next is broken by construction. Use `--query`
expressions (stable in *intent*), or re-list immediately before applying.

## 7. `jj op log` is a real undo substrate — CONFIRMED

```
$ jj op log --no-graph -T 'id.short() ++ " " ++ description ++ "\n"'
457bb0442a57 create bookmark my-feature pointing to commit d5ffa2d0...
1695f59b2b92 split commit 9e264c177c6ab75f1f0b7cdf68b13108fd9e469c
2086cd58175c snapshot working copy
4358c8a3cadc new empty commit
bb98165640ec describe commit 39bdf5af7b2ab15aed55366f2c792a24e24f23f6
1084e8fa7171 snapshot working copy
```

Every mutation, including `jj-hunk split`, is recorded and reversible. The
plugin should surface this rather than inventing an undo mechanism.

## 8. `jj sparse` exists

```
$ jj sparse --help
Commands: edit, list, reset, set
```

## What is still unverified

- `jj git push`, `jj bookmark track`, `jj git fetch` against a real remote —
  no remote was configured, so the push/bookmark-tracking claims in
  [09](09-github-upstream-and-remotes.md) remain **PLAUSIBLE**.
- Windows/macOS sandbox mechanisms behind `dsh-bash-sandbox`.
- The `jj-hunk` `--spec-file` JSON/YAML path (only `--query` was exercised).
- `jj-hunk commit` and `jj-hunk squash` (only `split` was exercised). The
  argument shapes are now confirmed from `--help`, but neither was run.
- The `--query` / `--include` mutual exclusion, which `--help` does not show.

## Second pass — official docs and the installed binary

Re-checked against **`jj` 0.46.0** (the installed binary) and the official
documentation at `docs.jj-vcs.dev/latest/`. The method matters: the CLI reference
page carries its own warning —

> This CLI reference is experimental. It is automatically generated, but does not
> match the `jj help` output exactly. Run `jj help <COMMAND>` for more
> authoritative documentation.

— so the docs were used for **semantics** and `jj help <cmd>` on 0.46.0 for
**exact flags**. Where the two disagree, the binary wins.

### What held

| Claim | How checked | Result |
|---|---|---|
| `jj diff -r <rev>` selects a revision | `jj help diff` → `-r, --revisions <REVSETS>` | **holds** (plural `--revisions`) |
| `jj log --no-graph -T 'json(self)' -r @` | executed | **holds** — one JSON object per commit |
| `jj op log --no-graph -T 'json(self)'` | executed | **holds** — one JSON object per operation |
| `jj op restore <OPERATION>` is positional | `jj help op restore` | **holds** |
| `jj git colocation disable` exists | `jj help git colocation` | **holds on 0.46.0** — so it is a valid alternative in the `rm -rf .git` message |
| `jj tag`, `jj absorb`, `jj duplicate`, `jj file annotate`, `jj edit`, `jj revert` | `jj help <cmd>` | all exist |
| `jj rebase -b/-s/-r/-o`, `jj revert -B`, `jj duplicate -o`, `jj restore --from`, `jj git push --bookmark`, `jj config set --user`, `jj workspace add --name` | `jj help <cmd>` | all hold |
| Empty identity blocks a push | executed with no user configured | **holds, with the official wording**: *"Warning: Name and email not configured. Until configured, your commits will be created with the empty identity, and can't be pushed to remotes."* The author renders as literally `\|` |
| `jj describe` preserves an author | authored commit, then `unset JJ_USER JJ_EMAIL`, then `jj describe -r @- -m renamed` | **holds** — author survived as `Real Author` |
| `jj resolve --list` exits 0 on a conflict | real 2-sided conflict | **holds** — printed `c.txt    2-sided conflict`, exit **0** |
| `jj log -T 'conflict' -r @` detects it | same repo | **holds** — `true` |
| `jj new` does **not** escape a conflict | `jj new` after the merge | **holds** — the new `@` still reports `conflict` = `true` |

### What was wrong, and is now fixed

1. **`jj rebase --before` is undocumented, though it works.** `jj help rebase`
   lists `-A, --insert-after` and `-B, --insert-before` — and no `--before`.
   Executing `jj rebase -r @- --before @` nonetheless succeeds, exit 0, doing
   exactly what `-B` does. So the message was not *broken*; it was relying on an
   alias that no help text promises. `src/messages.ts` now emits the documented
   `-B`, and the docs follow it.

   **This is the same trap as the `-r` alias below, and it caught me once.** I
   first recorded this as "the flag does not exist", on the strength of its
   absence from `--help` — the same inference I had already documented as unsafe
   two sections down. Absence from `--help` is evidence of being undocumented,
   not of being unsupported; only execution settles it.
2. **`jj bookmark move` has no `-r`.** The `jj_bookmark` tool passed `-r <revset>`
   for every subcommand. Verified per subcommand:

   | Subcommand | Revision flag |
   |---|---|
   | `create`, `set` | `-r <REVSET>` |
   | `move` | `--to <REVSET>` |
   | `delete`, `forget`, `rename` | none — positional names only |

   Passing the wrong one is a hard error, not a no-op. The mapping is now a pure
   exported function, `bookmarkArgv`, with a test per row.
3. **The `jj_bookmark` enum was missing four real subcommands** — `set` (the
   create-or-update one), `forget`, `rename`, `untrack`. Added.
4. **The `jj_squash` parameter description was wrong.** It said `--into`
   "defaults to the parent"; `jj help squash` gives `default: @` for both
   `--from` and `--into`. A bare `jj squash` folds the working copy into its
   parent, which is a different statement. Corrected.

### One undocumented behaviour worth knowing

**`-r` works on commands whose help does not list it.** `jj help describe` shows
only `-m`, `--stdin` and `--editor` — no revision flag — yet
`jj describe -r @- -m X` retargeted the *parent*, confirmed by reading both
change IDs back. The same is true of the positional-revset commands generally:
`-r` is accepted as an alias for the positional `[REVSETS]...`. Verified by
execution rather than by reading, because the help text does not say so.

### `jj-hunk` 0.5.1 — interface and exit codes

The `--query`-only design in [19](19-jj-hunk-provisioning.md) and
[08](08-jj-hunk.md) was re-checked against the installed binary.

| Claim | Check | Result |
|---|---|---|
| `--format json` is the default | `jj-hunk list --help` | **holds** — `[default: json]`, `[possible values: json, yaml, text]` |
| `--query` cannot combine with `--include`/`--exclude`/`--files` | executed | **holds** — `error: the argument '--query <QUERY>' cannot be used with '--files'`. Reproduced after an earlier pass could not see it in `--help`; the exclusion is a runtime error, not a documented one |
| `-r/--rev` takes a revset | `--help` → `-r, --rev <REV>` | **holds** |
| The message is a **positional**, not a flag | `jj-hunk split --help` → `Usage: jj-hunk split [OPTIONS] [SPEC] [MESSAGE]` | **holds** — and the plugin's argv is correct |
| `split --query <q> -r @ <message>` binds the message correctly | executed | **holds** — the split commit carried `desc=[my message]` |
| `squash` takes no message | `jj-hunk squash --help` → `[SPEC]` only | **holds** — the plugin already omits it |
| An **empty** `--query` fails but **exits 0** | `list --query ''` and `split --query ''` | **holds** — `Error: Invalid hunkset query` on stderr, exit **0**, and `split` created **no commit** |
| A query matching nothing returns an empty set, exit 0 | `list --query 'added(content:"ZZZNOMATCH")'` | **holds** — `{"files": []}`, exit **0** |

The last two rows are the whole reason `hunk.ts` previews with `listHunks` before
it mutates. A caller that trusted the exit code would treat a no-op as a success,
and on `split` would report a commit that was never created.

One correction to the earlier record: the `--query` / `--include` mutual
exclusion is **not** visible in `--help` — it is a runtime error only. An
earlier pass recorded it as unreproduced for that reason; it has since been
reproduced directly, and the row above now says so.

### `jj-hunk` needs no jj configuration

A tempting misconfiguration, and one this repo briefly carried: registering
`merge-tools.jj-hunk` so that `jj split --tool jj-hunk` works. **Do not.** Its
README is explicit:

> jj-hunk uses jj's diff-tool interface. […] **Commands supply the tool
> configuration automatically**; no interactive editor is required.

`jj-hunk` writes the tool config itself when it drives jj. A hand-written entry
changes nothing — measured: with `diff-args` and then `merge-args` both set,
`jj split --tool jj-hunk` still invoked the bare `["$left", "$right"]` default
and failed with `unrecognized subcommand '<path>/left'`. The `select` subcommand
is invoked *by* jj-hunk, not by a user wiring it up.

What `jj-hunk` *does* read from jj config is `hunkset-aliases`, through
`jj config`, so user, repository and workspace precedence all apply:

```toml
[hunkset-aliases]
"timeout_change()" = 'added(content:"timeout")'
```

### Audit of the documentation itself

The same method was turned on `SPEC.md` and all 36 documents, because the
guidance the model is told to follow is only as good as the commands in it.

Every `jj` subcommand and flag mentioned anywhere was extracted mechanically and
checked against the installed binary — **53 (subcommand, flag) pairs**. Five
errors turned up, all now fixed:

| Where | Was | Is | How it failed |
|---|---|---|---|
| `docs/26` | `jj git colocate` | `jj git colocation` | `jj help git colocate` → not a command |
| `docs/26`, `docs/21` | `jj help revsets` | `jj help -k revsets` | `jj help revsets` → not a command |
| `SPEC.md` | `jj resolve list` | `jj resolve --list` | `list` was parsed as a **path**: *"No matching entries for paths: list"* |
| `docs/09` | `jj sparse set --minus <path>` | `jj sparse set --clear --add <path>` | `--minus` does not exist — and `--remove` does not exclude either, because patterns are an inclusion set |
| `docs/13` | "`jj rebase --before` does not exist" | it exists but is undocumented | my own false claim, see below |

**The last row is the one worth keeping.** I wrote it after finding `--before`
absent from `jj help rebase`, and recorded it as "does not exist" — the exact
inference I had *already documented two sections earlier* as unsafe, on the
strength of the `-r` alias. Executing it settled the question: exit 0, same
effect as `-B`. Absence from `--help` is evidence of being **undocumented**, not
of being unsupported.

The guidance in `src/messages.ts` still uses the documented `-B`, which is the
right call — an alias no help text promises is a worse thing to instruct a model
to run — but the *reason* recorded for the change had to be corrected.

### What the audit did not find

No stale event or service name anywhere (see
[11](11-verified-dsh-api-contract.md) §"Sweep of every name"). Every error was a
`jj` command spelling. That asymmetry is the finding: the DSH surface had been
read from the source and held up under a mechanical sweep, while the `jj`
guidance had been written from recall and did not.

### The core model, checked

[07](07-jujutsu-core-model.md) makes two claims the whole plugin rests on —
change IDs survive rewrites, commit IDs do not, and `jj new` closes the current
change and starts a fresh one. Both were executed:

| Step | Change ID | Commit ID |
|---|---|---|
| initial `@` | `kzuwpmkozrnr` | `41d23fe823b9` |
| after `jj describe -m rewritten` | `kzuwpmkozrnr` **unchanged** | `bc13d9cc2bb0` **changed** |
| after `jj new -m next` | `xmpsyrxkvtsy` — fresh | `f2abbcc2eca4` — fresh |

And the revision `jj new` left behind became `@-` carrying the old change ID,
confirming *"it closes the current change ID and starts a fresh empty working
copy on top"*. This is why the plugin addresses revisions by change ID
everywhere: a rewrite that changes the commit ID leaves the model's reference
intact, which is the property the guard's messages depend on.

### The identity-repair instruction was wrong

`docs/26` told the reader to repair empty-authored commits with:

```
jj metaedit --update-author -r 'author("")'
```

**That command fails.** `author("")` also matches the **root commit**, which has
an empty author by construction and is immutable:

```
Error: The root commit 000000000000 is immutable
```

Verified on 0.46.0 with two empty-authored commits and no identity configured —
`author("")` selected three revisions (`b83f67be…`, `c7ad4cf6…`, and
`000000000000`), and `metaedit` refused. Subtracting the root works:

```
jj metaedit --update-author -r 'author("") ~ root()'
Modified 2 commits:
  skrswrvp 2d73ee0a empty author
```

The document now carries the working form. This is the kind of error a spelling
sweep cannot catch: every token in the broken command is valid, the flags exist,
and the revset parses — it fails on a *semantic* collision with a commit the
author never thinks about.

### Quoted `jj` messages

The documentation quotes `jj` output in 35 places, and a quoted message that no
longer matches is a silent lie — it is the evidence a reader is asked to trust.
The substantive ones were re-executed:

| Quoted in | Message | Result |
|---|---|---|
| `docs/21` | `Error: There is no jj repo in "."` | **exact** |
| `docs/20` | `Error: No git remotes to push to` | **exact** |
| `docs/20` | `Warning: No matching remotes for names: origin` | **exact** |
| `docs/13` | `Error: Invalid hunkset query` (from `jj-hunk`) | **exact** |
| `docs/14`, `docs/20`, `docs/21` | `Error: The target repo already exists` | **exact** — from `jj git init` inside an existing workspace |
| `docs/15` | `Warning: Name and email not configured…` | **exact** |
| `docs/21` | `Error: Failed to parse revset: Function \`git_head\` doesn't exist` | **exact** |

The fifth row is worth a note on method. I first tested it with
`jj git clone <src> <existing-dir>`, got
`Error: Destination path exists and is not an empty directory`, and briefly
recorded the doc as wrong. The doc was right and **my test was wrong**: it
quotes `jj git init`, not `jj clone`. A verification pass that does not read the
claim's context manufactures errors as easily as it finds them.

### Why `jj git push`, and what it refuses that `git push` would not

Worth stating because the answer is not "preference". In a **colocated** repo Git
is a second-class citizen, and the differences are all measured:

| | |
|---|---|
| `git symbolic-ref HEAD` | **`fatal: ref HEAD is not a symbolic ref`** — Git's HEAD is *detached*, because jj does not use Git branches |
| `git status` | `Not currently on any branch.` |
| `git push` (no arguments) | **fails** — `fatal: You are not currently on a branch` |
| `jj git push --bookmark <name>` | works, and tracks the bookmark |

So a model that reaches for `git push` does not merely use the wrong tool; it
uses a tool whose model of "the current branch" **does not exist** here.

And `jj git push` refuses two things `git push` would happily send:

```
Error: Won't push commit fcac4ff9ed12 since it has no author and/or committer set
Error: Won't push commit 2d563ffd2f53 since it has no description
```

The first is the empty-identity trap the plugin already fails closed on. The
second is a trap the plugin did not previously mention: **an undescribed commit
cannot be pushed.** `jj_new` takes an optional `message`; a model that omits it
builds a change it cannot publish. `jj` names the rejected commit in its hint, so
the failure is recoverable, but it is predictable and worth warning about at the
tool rather than at the push.
