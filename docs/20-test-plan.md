# 20 — Test plan

**Status:** plan. No plugin code exists yet; the fixtures do, and every command
in §b and §c marked _measured_ was executed on this machine against the built
fixtures.

Sources: [SPEC §5.1–§5.2, §7, §8, §10](../SPEC.md),
[11](11-verified-dsh-api-contract.md) (harness API),
[13](13-empirical-verification.md) (measured `jj` behaviour),
[15](15-verb-mapping.md) (the verb table and the parsing rule),
[17](17-bypass-and-approval.md) (decision kinds),
[12 §H](12-risks-and-open-questions.md) (the seven acceptance criteria).

---

## a. Layers

| #   | Layer                    | Subject                                                                            | Depends on                                        | Can prove                                                                                                                                                                          | Cannot prove                                                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| L1  | Unit — verb mapper       | `src/verbs.ts`: `classify(command) → Verdict`                                      | nothing (pure)                                    | The table is total over the corpus, deterministic, and every denial names a `jj` command that exists                                                                               | That anything calls it; that detection gates it; that the named `jj` command succeeds in the current workspace        |
| L2  | Unit — guard             | the `tools/pre-execute` listener                                                   | fake `exec`, stubbed `detect`, no fs, no binaries | The exact `PreToolDecision` for a `(tool, command, detection, config)` tuple; that non-`bash` tools pass; that detector errors fail open; that `exec.arguments` is never rewritten | Real `.jj` detection; real path resolution; cache invalidation timing; the harness's own dispatch and approval prompt |
| L3  | Integration — real repos | `detect` + `classify` driven against the fixtures with real `jj`, `git`, `jj-hunk` | the seven fixtures, real binaries                 | Detection on all seven shapes; that the `jj-hunk` round-trip works on a real repo; that the plugin writes nothing under `.jj/` or `.git/`                                          | The harness waterfall (needs a running DSH); the approval prompt; model recovery from a denial                        |

The harness boundary is **L3's ceiling**: nothing in this repo can exercise
`ctx.waterfall('tools/pre-execute', …)` without a live host. Everything L2
asserts is the listener's _return value_; the claim "the harness turns
`{kind:'deny'}` into `Error: <reason>`" rests on
[11 §1](11-verified-dsh-api-contract.md), not on a test here.

---

## b. Fixtures

Built by `test/fixtures/build-fixtures.sh` (the only committed generator). The
script deletes its root, rebuilds, and then **verifies** every shape below,
exiting non-zero if any check fails.

**Two callers, and only one of them is destructive.** Run by hand with no
argument, the script behaves as it always has: it wipes
`/tmp/dsh-jujutsu-fixtures` and rebuilds it. Run by `test/global-setup.ts` — the
path the suite takes — it is atomic instead, because the fixed root is shared by
every concurrent run and the old in-place rebuild let one run delete the tree
another was asserting on (the same bug the e2e root had). The suite's path builds
into a private sibling directory and publishes it with `rename`, which succeeds
only when the destination is absent or an empty directory; a loser discards its
staging root. A complete root is never rebuilt, so the common case is now zero
work.

One consequence worth knowing: if `/tmp/dsh-jujutsu-fixtures` exists but is
**incomplete** — left by an interrupted build or by the old in-place script — the
suite refuses to run rather than deleting a path another run may be reading, and
says which directory to remove. That is deliberate: a silent rebuild is how the
race got in.

| Fixture           | Shape (verified)                                                                                                                | Layer | Acceptance criteria                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------- |
| `plain-git`       | `git init -b main` + 1 commit. `.git/` directory, **no `.jj`**                                                                  | L3    | AC1, AC7                            |
| `not-a-repo`      | empty directory. Neither `.git` nor `.jj`                                                                                       | L3    | AC1, AC5 (negative control)         |
| `jj-native`       | `jj git init --no-colocate`: `.jj/` directory, **no `.git`**                                                                    | L3    | AC1, AC2 (deny even with no `.git`) |
| `jj-colocated`    | `jj git init`: `.jj/` **and** `.git/`                                                                                           | L3    | AC2, AC3, AC5, AC6, AC7             |
| `jj-secondary`    | colocated `primary/` + `jj workspace add secondary`. Secondary has `.jj/` as a **directory** and `.git` as a **file**           | L3    | AC1/AC2 detection (D5), AC6         |
| `jj-with-changes` | colocated; `src/server.js` holds two independent one-line changes (timeout `5000`→`30000`, `log.debug`→`log.info`), uncommitted | L3    | AC4                                 |
| `jj-nested`       | `jj-nested/outer` (colocated) with `jj-nested/outer/sub` a **second, inner** jj repo                                            | L3    | AC2 (nearest `.jj` wins), AC7       |

**Why each exists.** `plain-git` and `not-a-repo` are the invisibility pair: one
has `.git` and no `.jj`, the other has neither, so a detector that keys on
`.git` fails `plain-git` and a detector that requires any repo fails
`not-a-repo`. `jj-native` proves the guard does not depend on `.git` existing.
`jj-secondary` is the shape that broke an earlier draft (`.jj` stays a
directory; `.git` becomes a file — [13 §2](13-empirical-verification.md)).
`jj-with-changes` is the only fixture with hunk-level work. `jj-nested`
discriminates nearest-ancestor detection from outermost-ancestor detection.

### Shared environment

Every `jj` invocation in a test must carry the generated identity, never the
user's real config:

```bash
export JJ_CONFIG="/dev/null:/tmp/dsh-jujutsu-fixtures/jj-config.toml"
```

`/dev/null` first means `~/.config/jj/config.toml` is not read; the second path
supplies `user.name`/`user.email` so no command prints a "Name and email not
configured" warning. **Do not** use `jj config set --repo` for this: it writes
to `~/.config/jj/repos/<id>/config.toml`, outside the fixture, and the fixture
stops being self-contained.

`jj root` reports `/private/tmp/...` for a fixture at `/tmp/...` (macOS resolves
the symlink). Assert against `pwd -P`, not the literal path.

---

## c. Acceptance criteria → assertions

`docs/12 §H` lists seven criteria. Each becomes an assertion below. Every
decision assertion pins the config unless the row says otherwise:

```ts
{ guard: 'deny', bypass: 'deny', readOnlyGit: 'deny', enabled: true }   // CI posture
```

Under the default `bypass: 'ask'` every `deny` below becomes
`{kind:'ask', reason, displayReason}` with the same `reason`
([17 §Outcome matrix](17-bypass-and-approval.md)). AC2b covers the variants.

### AC1 — In a non-`jj` repo the plugin is invisible

Under the default settings, including `forceJj: false`. The opt-in is a separate
contract and has its own cases in `test/guard.test.ts` (refused where a workspace
is missing, allowed for init/clone/config/help/version/`-R`).

| Field                      | Value                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture                    | `plain-git`, `not-a-repo`                                                                                                                                                                                                                                                                                                          |
| Call                       | For each of the 12 commands `git status`, `git commit -m x`, `git push`, `git log`, `jj log`, `jj git export`, `pnpm build`, `ls -la`, `cat .git/config`, `echo "git commit"`, `grep -r git src/`, `sh -c 'git commit'`: a `bash` `ToolExecution` with `arguments.command = <cmd>` and `exec.agent.session.header.cwd = <fixture>` |
| Expected                   | The listener returns `undefined` (calls `next()`); the waterfall's default `{kind:'allow'}` stands. Deep-equal against the decision captured with the plugin **not** loaded                                                                                                                                                        |
| Expected (no context)      | `ctx.systemPrompt.context(...)` is never registered for these roots, so no injection block is added ([22](22-context-injection.md))                                                                                                                                                                                                |
| Expected (no per-call I/O) | With a warm cache, N=100 calls perform exactly **one** `ctx.fs.stat` on `<root>/.jj` — not one per call                                                                                                                                                                                                                            |
| Failure looks like         | Any `deny`/`ask`; a `stat` per call; an injected context block; a non-zero exit from a call that succeeds with the plugin absent                                                                                                                                                                                                   |

Latency is a **budget, not a measurement**: added p50 < 5 ms per call with a
warm cache. Record it, but gate on the call-count assertion, which is
deterministic.

### AC2 — `git commit` / `git checkout -b` / `git branch` are denied with a correct, actionable replacement

| Field                         | Value                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture                       | `jj-colocated` (L3); fake `exec` (L2); no fixture (L1)                                                                                                                                                                                                                                                                                                                                                     |
| Call                          | `bash` with `command = "git commit -m \"x\""`, `"git checkout -b feat"`, `"git branch"`; cwd = `jj-colocated`                                                                                                                                                                                                                                                                                              |
| Expected decision             | `{kind:'deny', reason: <docs/15 §1 denial-message cell, byte-for-byte>}`                                                                                                                                                                                                                                                                                                                                   |
| Expected reason, literally    | `git commit -m "x"` → ``Refused `git commit -m`: run `jj commit -m "..."`.`` · `git status` → ``Refused `git status`: this is a Jujutsu workspace. Run `jj status` (alias `jj st`) — it shows the working-copy change and its parent commit.`` · `git diff` → ``Refused `git diff`: Jujutsu has no staging index. Run `jj diff` for the working-copy change, or `jj diff -r <rev>` for another revision.`` |
| Expected reason, structurally | The reason contains at least one backtick-delimited `jj …` token, and that token's program is `jj` or `jj-hunk`                                                                                                                                                                                                                                                                                            |
| Expected (actionability)      | Extract every `` `jj …` `` token from the reason, substitute the placeholders (`<rev>`→`@-`, `<name>`→`test`, `<path>`→`README.md`, `<dir>`→`.`), run it in a **copy** of `jj-colocated` with `JJ_CONFIG` set. It must exit **0**, or exit 1 with a message that is not `unrecognized subcommand`                                                                                                          |
| Failure looks like            | `next()`; a reason with no `jj` token; a reason naming a command `jj` rejects as unknown; the model's replacement not existing                                                                                                                                                                                                                                                                             |

**Known failure of the actionability clause, already measured.** The `git init`
row's reason says "run `jj git init`", but inside an existing workspace:

```
$ jj git init          # in a copy of jj-colocated
Error: The target repo already exists      # exit 1
```

This is a real defect in the message, not a test artefact. Either the reason
must say `jj git init <dir>` (for a _different_ directory) or the `git init` row
must be excluded from the actionability clause. **Decide before AC2 is green.**

### AC2b — the config matrix

Same calls, different config; one row per cell of
[17 §Outcome matrix](17-bypass-and-approval.md):

| Config                                    | `git commit -m x` in `jj-colocated`                                           | `jj new` |
| ----------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `bypass:'deny'`                           | `{kind:'deny', reason}`                                                       | `next()` |
| `bypass:'ask'`, approval policy `'ask'`   | `{kind:'ask', reason, displayReason}`                                         | `next()` |
| `bypass:'ask'`, approval policy `'never'` | `{kind:'deny', reason}` — **our** reason, not `the user rejected tool "bash"` | `next()` |
| `bypass:'allow'`                          | `next()`                                                                      | `next()` |
| `guard:'off'`                             | `next()` for every command in §d                                              | `next()` |

The `never` row is the one that matters: [17](17-bypass-and-approval.md) shows
`dsh-tools` substitutes its own rejection text, so a guard that asks blindly
destroys the verb mapper's only product.

### AC3 — `jj git export` and `jj git push` still work

| Field                                           | Value                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture                                         | `jj-colocated`                                                                                                                                                      |
| Call                                            | `bash` with `command = "jj git export"` and `command = "jj git push --bookmark test-bookmark"`                                                                      |
| Expected decision                               | `next()` for both — program resolves to `jj`, not `git`                                                                                                             |
| Expected observable, `jj git export` (measured) | exit 0, stdout exactly `No export needed in colocated workspaces.`                                                                                                  |
| Expected observable, `jj git push` (measured)   | exit 1, stderr `Warning: No matching remotes for names: origin` + `Error: No git remotes to push to` — a **jj** error. Assert the tool result is not a guard denial |
| Failure looks like                              | `{kind:'deny'}` or `{kind:'ask'}` for either; the push error text being `Refused \`git push\`` or similar                                                           |

### AC4 — `jj-hunk list` → `split` round-trips on a two-change fixture file

| Field              | Value                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture            | `jj-with-changes` (run on a **copy**; the round-trip mutates the repo)                                                                                                                                            |
| Step 1             | `jj-hunk list --format json` → exactly **2** hunk objects, both under `src/server.js` (measured: `grep -c '"id":'` = 2)                                                                                           |
| Step 2             | `jj-hunk split --query 'added(content:"30000")' "fix: increase timeout"` → creates a commit whose description is `fix: increase timeout` (measured: `Selected changes : trxllkwz 2a277c2e fix: increase timeout`) |
| Step 3             | `jj diff --stat` → `src/server.js \| 2 +-` — the log-level change is **still in the working copy** (measured)                                                                                                     |
| Step 4             | `jj log --no-graph -T 'description.first_line() ++ "\n"'` → contains `fix: increase timeout` and `base`                                                                                                           |
| Expected (IDs)     | The test never carries a hunk ID across steps; if it does, it must re-`list` immediately before applying ([13 §6](13-empirical-verification.md))                                                                  |
| Failure looks like | Hunk count ≠ 2; the split commits both changes (`jj diff --stat` empty); `--query` matches 0 hunks; a spec file written inside the working copy (it invalidates its own IDs)                                      |

### AC5 — Colocated repos keep working for an external `gh` invocation after export

| Field              | Value                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture            | `jj-colocated` (copy); `not-a-repo` as the negative control                                                                                                                                                   |
| Step 1             | `jj bookmark create test-bookmark -r @-` → `Created 1 bookmarks …`                                                                                                                                            |
| Step 2             | `jj git export` → `No export needed in colocated workspaces.`                                                                                                                                                 |
| Step 3 (measured)  | `git branch --list` contains `test-bookmark`; `git rev-parse test-bookmark` == `jj log --no-graph -r test-bookmark -T 'commit_id'` (both `6974412eb762997625e6f86e1539b457ea2c5f01` in the run recorded here) |
| Step 4 (measured)  | `gh repo view` in the fixture prints `no git remotes found` — i.e. `gh` **resolved** the workspace's `.git`. In `not-a-repo` the same command prints `failed to run git: fatal: not a git repository`         |
| Expected           | Steps 3–4 hold with no `jj git export` having written anything                                                                                                                                                |
| Failure looks like | `git branch --list` lacking the bookmark; the SHAs differing; `gh` reporting "not a git repository" in the colocated fixture                                                                                  |
| Note               | `gh` needs a remote and auth for anything past ref resolution; the ref-level assertion is the portable part, `gh repo view` is the end-to-end smoke                                                           |

### AC6 — The plugin never writes to `.jj/` or `.git/` directly

| Field                       | Value                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture                     | `jj-colocated`                                                                                                                                                                           |
| Method                      | `find .jj .git -type f -exec shasum -a 256 {} + \| sort` → manifest; compare before/after                                                                                                |
| Method has power (measured) | `jj commit -m mutate` **changes** the manifest; `cat README.md` does not                                                                                                                 |
| Call set                    | The AC2 denial set (`git commit`, `git checkout -b`, `git branch`), all denied — no `jj` process runs, so the manifest must be **identical**                                             |
| Second assertion            | Spy on `ctx.fs`: no `writeText`/`writeBytes` call whose path contains `/.jj/` or `/.git/`, on any code path                                                                              |
| Caveat                      | A call that legitimately runs `jj` **does** mutate `.jj` (op log, snapshot). To attribute a change to the plugin, run the same command with the plugin absent and diff the two manifests |
| Failure looks like          | A manifest diff on the denied-only set; a `writeText` call; a new file under `.jj/` or `.git/`                                                                                           |

### AC7 — A session that starts outside a `jj` repo and later enters one starts enforcing

Two variants; both must pass.

| Variant           | Sequence                                                                                                                                                                                                                                | Expected                                         | Failure                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| (a) cwd change    | Call 1: `bash git status`, cwd = `plain-git` → allow. Call 2: same command, `session.header.cwd` = `jj-colocated` → deny                                                                                                                | Detection is keyed per **root**, not per session | Call 2 still allowed (session-scoped cache)        |
| (b) in-place init | Call 1: `bash git status`, cwd = a **copy** of `plain-git` → allow. Call 2: `bash jj git init` (allowed — program is `jj`; measured: converts the repo in place, both `.git/` and `.jj/` now present). Call 3: `bash git status` → deny | `jj git init` invalidates the cache (D5)         | Call 3 still allowed — the cache never invalidated |

---

## d. The guard decision table

**Assumptions.** Workspace = `jj-colocated` (detection `kind: 'jj-colocated'`);
config = `{guard:'deny', bypass:'deny', readOnlyGit:'deny'}`. `deny` means
`{kind:'deny', reason}` where `reason` is the [15 §1](15-verb-mapping.md) cell
byte-for-byte; `next()` means the listener returns `undefined` and the waterfall
default `{kind:'allow'}` stands. Under `bypass:'ask'` every `deny` becomes
`{kind:'ask', reason, displayReason}`; under `bypass:'allow'` every `deny`
becomes `next()`.

**"program resolved"** is not asserted from reading — it is the output of
`node scripts/probe-invocation.mjs -c '<command>'` (the prototype of
[15 §4](15-verb-mapping.md)'s rule), run over every row below. Where the probe
reports `low` confidence, the row is opaque to the parser and the decision must
still be made on the resolved program.

**Total: 104 rows.** Rows 1–98 are decided; rows 99–104 are **OPEN**.

### d.1 Plain `git` verbs — deny

| #   | command                                   | program      | decision | replacement named                                     |
| --- | ----------------------------------------- | ------------ | -------- | ----------------------------------------------------- |
| 1   | `git status`                              | `git`        | deny     | `jj status`                                           |
| 2   | `git diff`                                | `git`        | deny     | `jj diff`                                             |
| 3   | `git log --oneline`                       | `git`        | deny     | `jj log`                                              |
| 4   | `git add .`                               | `git`        | deny     | none — auto-tracked                                   |
| 5   | `git add -p`                              | `git`        | deny     | `jj-hunk commit --query`                              |
| 6   | `git commit -m "x"`                       | `git`        | deny     | `jj commit -m`                                        |
| 7   | `git commit --amend`                      | `git`        | deny     | `jj describe` / `jj squash`                           |
| 8   | `git branch`                              | `git`        | deny     | `jj bookmark list`                                    |
| 9   | `git branch -a`                           | `git`        | deny     | `jj bookmark list --all-remotes`                      |
| 10  | `git checkout -b feat`                    | `git`        | deny     | `jj new` + `jj bookmark create`                       |
| 11  | `git switch main`                         | `git`        | deny     | `jj new <rev>` / `jj edit <rev>`                      |
| 12  | `git merge origin/main`                   | `git`        | deny     | `jj new @ <rev>`                                      |
| 13  | `git rebase -i HEAD~3`                    | `git`        | deny     | `jj rebase -r … -B`                                   |
| 14  | `git reset --hard`                        | `git`        | deny     | `jj restore` / `jj abandon`                           |
| 15  | `git stash`                               | `git`        | deny     | `jj new @-`                                           |
| 16  | `git stash pop`                           | `git`        | deny     | `jj edit <change-id>`                                 |
| 17  | `git cherry-pick abc1234`                 | `git`        | deny     | `jj duplicate`                                        |
| 18  | `git revert abc1234`                      | `git`        | deny     | `jj revert -r`                                        |
| 19  | `git tag v1.0.0`                          | `git`        | deny     | `jj tag set`                                          |
| 20  | `git push origin main`                    | `git`        | deny     | `jj git push --bookmark`                              |
| 21  | `git push --force`                        | `git`        | deny     | `jj git push` (no force)                              |
| 22  | `git pull`                                | `git`        | deny     | `jj git fetch` + `jj rebase`                          |
| 23  | `git fetch`                               | `git`        | deny     | `jj git fetch`                                        |
| 24  | `git clone https://example.invalid/x.git` | `git`        | deny     | `jj git clone`                                        |
| 25  | `git remote -v`                           | `git`        | deny     | `jj git remote list`                                  |
| 26  | `git remote add origin …`                 | `git`        | deny     | `jj git remote add`                                   |
| 27  | `git worktree add ../wt`                  | `git`        | deny     | `jj workspace add`                                    |
| 28  | `git submodule update --init`             | `git`        | deny     | SPECIAL — no `jj` equivalent                          |
| 29  | `git bisect start`                        | `git`        | deny     | `jj bisect run`                                       |
| 30  | `git blame src/server.js`                 | `git`        | deny     | `jj file annotate`                                    |
| 31  | `git show HEAD`                           | `git`        | deny     | `jj show`                                             |
| 32  | `git clean -fd`                           | `git`        | deny     | SPECIAL — `rm`                                        |
| 33  | `git restore src/server.js`               | `git`        | deny     | `jj restore`                                          |
| 34  | `git init`                                | `git`        | deny     | `jj git init` ⚠ **not actionable in place** — see AC2 |
| 35  | `git -C ../other status`                  | `git`        | deny     | `jj -R ../other status`                               |
| 36  | `git config user.name "x"`                | `git`        | deny     | `jj config set`                                       |
| 37  | `git config --get user.name`              | `git`        | deny     | `jj config list`                                      |
| 38  | `git lfs pull`                            | `git`        | deny     | SPECIAL — no LFS                                      |
| 39  | `git -c user.name=x commit -m y`          | `git`        | deny     | `jj commit -m`                                        |
| 40  | `git status --porcelain`                  | `git`        | deny     | `jj status`                                           |
| 41  | `git status 2>&1 \| tee log`              | `git`, `tee` | deny     | `jj status`                                           |
| 42  | `/usr/bin/git status`                     | `git`        | deny     | `jj status`                                           |
| 43  | `./git status`                            | `git`        | deny     | `jj status`                                           |

### d.2 Different binaries that merely start with `git` — allow

| #   | command        | program   | decision | note                                                                      |
| --- | -------------- | --------- | -------- | ------------------------------------------------------------------------- |
| 44  | `git-lfs pull` | `git-lfs` | next()   | basename ≠ `git`; a different binary ([15 §2 rule 4](15-verb-mapping.md)) |
| 45  | `lazygit`      | `lazygit` | next()   | same                                                                      |

### d.3 `jj` verbs — allow

| #   | command                                                         | program   | decision |
| --- | --------------------------------------------------------------- | --------- | -------- |
| 46  | `jj status`                                                     | `jj`      | next()   |
| 47  | `jj log`                                                        | `jj`      | next()   |
| 48  | `jj commit -m "x"`                                              | `jj`      | next()   |
| 49  | `jj new`                                                        | `jj`      | next()   |
| 50  | `jj log -r 'git_head()'`                                        | `jj`      | next()   |
| 51  | `jj -R ../other status`                                         | `jj`      | next()   |
| 52  | `jj-hunk list --format json`                                    | `jj-hunk` | next()   |
| 53  | `jj-hunk split --query 'added(content:"30000")' "fix: timeout"` | `jj-hunk` | next()   |

### d.4 `jj git …` carve-outs — allow

The carve-out is not an exception list: `jj git export` resolves to program
`jj` ([15 §2](15-verb-mapping.md)). These rows are the regression suite for a
naive "contains `git`" guard.

| #   | command                                      | program | decision |
| --- | -------------------------------------------- | ------- | -------- |
| 54  | `jj git export`                              | `jj`    | next()   |
| 55  | `jj git push --bookmark feat`                | `jj`    | next()   |
| 56  | `jj git fetch`                               | `jj`    | next()   |
| 57  | `jj git clone https://example.invalid/x.git` | `jj`    | next()   |
| 58  | `jj git init`                                | `jj`    | next()   |
| 59  | `jj git remote list`                         | `jj`    | next()   |
| 60  | `jj git colocation status`                   | `jj`    | next()   |

### d.5 Non-repo and non-`git` commands — allow

| #   | command                                                            | program             | decision | note                                                                              |
| --- | ------------------------------------------------------------------ | ------------------- | -------- | --------------------------------------------------------------------------------- |
| 61  | `pnpm build`                                                       | `pnpm` (low)        | next()   | opaque dispatcher                                                                 |
| 62  | `pnpm build && jj log`                                             | `pnpm`, `jj` (low)  | next()   |                                                                                   |
| 63  | `ls -la`                                                           | `ls`                | next()   |                                                                                   |
| 64  | `cat .git/config`                                                  | `cat`               | next()   | a substring scan would wrongly deny this                                          |
| 65  | `rm -rf .git`                                                      | `rm`                | next()   | ⚠ **accepted gap** — destroys a colocated repo; out of scope for a Git-verb guard |
| 66  | `npm run git:check`                                                | `npm` (low)         | next()   | `git` in a script _name_                                                          |
| 67  | `grep -r git src/` / `grep -rn "git status" docs/`                 | `grep`              | next()   | a grep pattern, not an invocation                                                 |
| 68  | `echo "git commit -m x"`                                           | `echo`              | next()   | a string, not an invocation                                                       |
| 69  | `gh pr create --fill`                                              | `gh`                | next()   | not a Git command                                                                 |
| 70  | `make commit`                                                      | `make` (low)        | next()   | ⚠ unfixable false negative — the Makefile is not read                             |
| 71  | `./scripts/commit.sh`                                              | `commit.sh` (low)   | next()   | ⚠ unfixable false negative                                                        |
| 72  | `python3 -c "import subprocess; subprocess.run(['git','status'])"` | `python3` (low)     | next()   | ⚠ unfixable false negative                                                        |
| 73  | `alias gs='git status'; gs`                                        | `alias`, `gs` (low) | next()   | ⚠ unfixable — alias expansion is inside the shell                                 |
| 74  | `g=git; $g status`                                                 | `[]` (low)          | next()   | ⚠ unfixable — variable indirection                                                |
| 75  | `""` (empty)                                                       | `[]`                | next()   | fail open, log once ([SPEC §8](../SPEC.md))                                       |

### d.6 Wrapper forms — deny

| #   | command                    | program | decision | note                                                                                                                                              |
| --- | -------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 76  | `command git status`       | `git`   | deny     |                                                                                                                                                   |
| 77  | `env FOO=1 git push`       | `git`   | deny     | assignment stripped                                                                                                                               |
| 78  | `nohup git --version`      | `git`   | deny     |                                                                                                                                                   |
| 79  | `sudo git commit`          | `git`   | deny     |                                                                                                                                                   |
| 80  | `time git status`          | `git`   | deny     |                                                                                                                                                   |
| 81  | `nice git log`             | `git`   | deny     |                                                                                                                                                   |
| 82  | `exec git status`          | `git`   | deny     |                                                                                                                                                   |
| 83  | `doas git status`          | `git`   | deny     |                                                                                                                                                   |
| 84  | `nice -n 10 git log`       | `git`   | deny     | needs a per-wrapper **flag-value** table, not just a word list                                                                                    |
| 85  | `sudo -u root -- git push` | `git`   | deny     | same                                                                                                                                              |
| 86  | `env -i git status`        | `git`   | deny     | same                                                                                                                                              |
| 87  | `\git commit`              | `git`   | deny     | intent is [12 §B](12-risks-and-open-questions.md); **rule 2 does not yet say to strip the leading backslash** — amend [15 §2](15-verb-mapping.md) |

### d.7 `sh -c` / `eval` nesting — recurse

| #   | command                   | program       | decision | note                         |
| --- | ------------------------- | ------------- | -------- | ---------------------------- |
| 88  | `sh -c 'git commit -m x'` | `sh`, `git`   | deny     | recursed                     |
| 89  | `bash -lc 'git commit'`   | `bash`, `git` | deny     | recursed                     |
| 90  | `zsh -c 'git status'`     | `zsh`, `git`  | deny     | recursed                     |
| 91  | `eval 'git status'`       | `git`         | deny     | recursed                     |
| 92  | `sh -c 'jj git export'`   | `sh`, `jj`    | next()   | recurse, then carve-out      |
| 93  | `sh -c 'echo git commit'` | `sh`, `echo`  | next()   | recurse, then false positive |

### d.8 Substitutions — deny

| #   | command                           | program       | decision | note                                                                                                   |
| --- | --------------------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| 94  | `echo "v=$(git rev-parse HEAD)"`  | `git`, `echo` | deny     | recursion into `$()` also catches read-only introspection; [15 §4](15-verb-mapping.md) prefers denying |
| 95  | ``echo "v=`git rev-parse HEAD`"`` | `git`, `echo` | deny     | the backtick form, same rule                                                                           |

### d.9 Compound fragments

| #   | command                        | program      | decision | note                       |
| --- | ------------------------------ | ------------ | -------- | -------------------------- |
| 96  | `jj status && git commit -m x` | `jj`, `git`  | deny     | one Git fragment is enough |
| 97  | `jj status; git log`           | `jj`, `git`  | deny     |                            |
| 98  | `git status \| cat`            | `git`, `cat` | deny     |                            |

### d.10 Resolved — these rows were OPEN

> **All six are now decided.** See [`docs/14-decision-log.md`](14-decision-log.md)
> §R1–R7: **R1** `xargs` is a wrapper — strip it and recurse (the "prefer ALLOW"
> worry does not apply to a name-based recursion); **R2** `timeout`, `setsid`,
> `stdbuf`, `chrt` and `ionice` join the wrapper list; **R3–R5** one generic
> fallback reason, so an unmatched `git` form never falls through to allow;
> **R6** flags win over the verb — only positively identified _listing_ forms
> are read-only; **R7** `git init`'s replacement message is corrected (inside a
> `jj` workspace, `jj git init` exits 1).
>
> The table keeps the original questions for context.

| #   | command                                             | probe       | question                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 99  | `xargs git add` and `echo hi \| xargs git add`      | `git` (low) | [15 §2 rule 2](15-verb-mapping.md) lists `xargs` as a wrapper to strip; [15 §4](15-verb-mapping.md) says "**Prefer ALLOW**: treating `xargs` as a wrapper creates false positives on `xargs rm`". The two contradict. `scripts/probe-invocation.mjs` currently treats it as a wrapper at low confidence and cites a "docs/21 §b" that does not exist. **Which wins?** |
| 100 | `timeout 5 git status`                              | `timeout`   | `timeout` is absent from the wrapper word list, so the program resolves to `timeout` and the row would be **allowed** while Git really runs. **Is `timeout` a wrapper, and does the list need `stdbuf`/`setsid` too?**                                                                                                                                                |
| 101 | `git` (bare, no subcommand)                         | `git`       | [15 §2 rule 4](15-verb-mapping.md) says deny any invocation whose basename is `git`, so the _kind_ is decided — but [15 §1](15-verb-mapping.md) has no row, so **which reason string?**                                                                                                                                                                               |
| 102 | `git --version`                                     | `git`       | Same. [15 §4](15-verb-mapping.md) implies deny (it lists `nohup git --version` as a should-deny false negative), but there is no reason text                                                                                                                                                                                                                          |
| 103 | `git frobnicate` (subcommand absent from the table) | `git`       | Same: deny by rule, **but what is the generic fallback reason** for a `git` subcommand with no [15 §1](15-verb-mapping.md) row?                                                                                                                                                                                                                                       |
| 104 | `git branch -d feat` under `readOnlyGit:'allow'`    | `git`       | [17](17-bypass-and-approval.md) names `branch` among the read-only verbs, but `-d`/`-D`/`<name>` mutate. **Which classification wins — the verb or the flags?** Same question for `git config --get` vs `git config user.name x`, and `git tag` (list vs create)                                                                                                      |

**OPEN count: 0** — rows 99–104 are resolved in
[`docs/14-decision-log.md`](14-decision-log.md) §R1–R7. Rows 1–98 were already
decided.

---

## e. How to run it

```bash
pnpm install
pnpm run ci          # vp check (format, lint, typecheck), build, the suite, the tarball
```

The fixtures are **not** a step you run. `test/global-setup.ts` builds them before
the suite, by calling the script below. That changed because of a real failure:
the fixtures used to be built by hand, so they existed on the machine where
somebody had run the script and nowhere else — and nine guard tests failed on
every CI push for a week with `expected 'allow' to be 'deny'`, a message that
blames the guard rather than the missing directory.

The script is still runnable directly, and useful when a fixture looks wrong:

```bash
./test/fixtures/build-fixtures.sh              # default root /tmp/dsh-jujutsu-fixtures
./test/fixtures/build-fixtures.sh /tmp/other   # any root
```

`jj` and `jj-hunk` must be on `PATH` for the tests that drive them. When they are
not, those tests **skip** and the setup prints a line saying so — which is right
on a laptop and wrong in CI, so the workflows set `DSH_JUJUTSU_REQUIRE_TOOLS=1`
and turn the skip into an error. A green CI therefore means the binaries ran.

An earlier revision of this section said the suites were "NOT YET RUNNABLE"
because the tree had no `package.json`. That was true when it was written and
false by the time anyone read it again; the tree has one, and 193 tests.

### A green run

```
verifying fixtures under /tmp/dsh-jujutsu-fixtures
  ok    dir  plain-git/.git
  ok    absent plain-git/.jj
  ok    not-a-repo is empty
  ok    dir  jj-native/.jj
  ok    absent jj-native/.git
  ok    dir  jj-colocated/.jj
  ok    dir  jj-colocated/.git
  ok    dir  jj-secondary/primary/.jj
  ok    dir  jj-secondary/primary/.git
  ok    dir  jj-secondary/secondary/.jj
  ok    file jj-secondary/secondary/.git
  ok    dir  jj-with-changes/.jj
  ok    dir  jj-with-changes/.git
  ok    jj-with-changes: jj-hunk lists 2 hunks
  ok    dir  jj-nested/outer/.jj
  ok    dir  jj-nested/outer/.git
  ok    dir  jj-nested/outer/sub/.jj
  ok    jj-nested: jj root inside sub/ is the inner repo
all fixtures verified
```

That is the real output of the script on this machine (jj writes its own
progress lines to stderr; they are not part of the report). Then L1 reports
`98/98` decided corpus rows matching §d, L2 reports the same count as decisions,
and L3 reports per-fixture assertions from §c.

A red run prints the first `FAIL` line and exits non-zero: the fixture script
exits `1` on any shape mismatch, and the suites exit non-zero on any decision
mismatch.

### Inspecting by hand

```bash
cd /tmp/dsh-jujutsu-fixtures/jj-colocated
jj status && git branch --list
jj-hunk list --format json            # in jj-with-changes
node scripts/probe-invocation.mjs -c 'env FOO=1 git push'
```

---

## f. What this plan cannot prove

| Gap                                                                              | Why                                                                                                                                                                                                              | What would be needed                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `{kind:'ask'}` actually prompt?                                             | [17 §Verification status](17-bypass-and-approval.md) records the end-to-end prompt-then-run flow as **UNVERIFIED**. No fixture can compose an answerer                                                           | A live DSH session with a real `ctx.get('approval')` answerer, one `git commit` call, and a human clicking yes — then asserting the command really ran (the bypass must not translate) |
| ~~Does the harness turn `{kind:'deny'}` into `Error: <reason>`?~~                | **VERIFIED LIVE.** A real session produced `Refused: git status describes a Git working tree that does not exist here. Run: jj status` for a refused call, and the same shape for a mutating one.                | —                                                                                                                                                                                      |
| ~~Does the injected context reach the model?~~                                   | **VERIFIED LIVE.** The harness reports the assembled context each turn: `Workspace root: …`, `Layout: colocated with Git (.git and .jj both present)`, `Working copy @: …`, `Hunk selection: jj-hunk available`. | —                                                                                                                                                                                      |
| Does `tools.guard` (monotonic) interact correctly with our `pre-execute` bypass? | [17](17-bypass-and-approval.md) requires a future guard to consult the same allowlist; none exists yet                                                                                                           | Add the guard, then a test that a denied call cannot be force-allowed by another plugin                                                                                                |
| ~~Does the model recover in one step from a denial?~~                            | **VERIFIED LIVE.** This document was edited through a session in which every Git command was refused and every refusal was followed by the `jj` equivalent, with no retry of the refused form.                   | —                                                                                                                                                                                      |
| ~~Real `jj git push` / `fetch` against a remote~~                                | **VERIFIED LIVE.** This repository is colocated and publishes with `jj git push --bookmark main` to `origin`; the commits are readable through the GitHub API afterwards.                                        | —                                                                                                                                                                                      |
| Windows / sandbox executor differences                                           | Nothing here ran under `dsh-bash-sandbox`                                                                                                                                                                        | A sandbox-executor run of the L3 suite                                                                                                                                                 |
| Parser behaviour on shell constructs the probe does not model                    | The probe is explicit: no heredocs, process substitution, `${x:-y}`, `coproc`; the parser is a prototype, not production code                                                                                    | Either accept the gap (the model emits `git commit`, not `coproc`) or adopt a real shell AST                                                                                           |

The honest summary, revised. This plan proves **the guard's decisions and the
fixtures' shapes**. Four of the gaps below have since been closed by watching a
real session rather than by adding a test, which is the only way some of them
could ever close: the harness's half of the contract is observable from inside a
session and not from a fixture.

What remains is genuinely open. **The `{kind:'ask'}` prompt is the first one**,
because every bypass decision in [17](17-bypass-and-approval.md) depends on it and
nothing here touches it — a refusal is observable from inside a session, but an
approval needs a human to answer, which no session this document was written in
could do.

The other three are narrow: the monotonic `tools.guard` interaction needs a second
plugin that does not exist, the sandbox-executor differences need a run under
`dsh-bash-sandbox`, and the parser's shell-construct gap is a deliberate limit of a
prototype that is explicit about it.
