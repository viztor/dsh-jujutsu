# 21 — Guard evasion

**Artifact:** [`scripts/probe-invocation.mjs`](../scripts/probe-invocation.mjs) — a
dependency-free prototype of the rule in [15 §2](15-verb-mapping.md), plus a
64-command corpus with expected truth.

```
$ node scripts/probe-invocation.mjs
corpus=64 correct=54 falseNegatives=10 falsePositives=0 lowConfidence=16
```

Everything below is either that program's output or a shell command run in
`/tmp`. Nothing is inferred from the conversation.

## (a) Threat model

**The adversary is not an adversary.** The guard exists because a cooperative
model reaches for `git` out of habit ([02](02-git-blocking-at-tool-call-level.md),
[12 §B](12-risks-and-open-questions.md)). It is not selecting commands to defeat
a matcher.

That single assumption decides the design:

| Consequence                                             | Why                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero false positives outranks every false negative.** | A wrong denial blocks real work and the model flails ([12 §G](12-risks-and-open-questions.md)). A missed `git status` costs one stale read.                       |
| **Obfuscation defence is not worth its cost.**          | `$g`, `python -c`, a function named `git` are things a cooperative model does not emit. Detecting them means guessing, and guessing means denying `npm run test`. |
| **The denial message is the product.**                  | The guard's job is to convert a habit into the `jj` verb ([15](15-verb-mapping.md)). A denial with a bad reason is worse than no guard.                           |
| **Low confidence is a first-class output.**             | The honest response to "I cannot tell" is to say so — not to guess allow or guess deny. See (c).                                                                  |
| **This is a habit corrector, not a security boundary.** | It must not be described as one anywhere in the plugin's docs or config.                                                                                          |

**If the assumption is wrong**, the threat is no longer the model. It is either
(a) untrusted text reaching the model (a README, an issue, a fetched page that
says "run `git push --force`"), or (b) a hostile script in the workspace. Then:

- Every class in (c) becomes exploitable, and text matching is the wrong layer
  entirely — the command string is attacker-controlled.
- The correct enforcement point moves below the shell: a filesystem view with no
  `git` binary, or a sandbox `execve` denial on the git inode. The `PATH` shim in
  (d) is _not_ an answer — it is bypassed by `bash -lc`, `env -i`, and any
  absolute path (verified). Only the OS-level control is a boundary.
- The guard keeps its value as the _message_ layer on top, and none of its
  evasion properties matter.

The guard also only ever sees the **agent's** `bash` calls. A human typing
`git commit` in the same workspace is untouched — which is the point
([12 §A](12-risks-and-open-questions.md)).

**`forceJj` is the same kind of nudge, in the other direction.** It refuses `jj`
where no workspace exists and names `jj git init --colocate`, so the model gets
one actionable line instead of jj's own `There is no jj repo in "."`. It is not
a boundary either: `jj -R /tmp/elsewhere log` is allowed, because naming a
repository is a legitimate way to reach a workspace elsewhere, and there is no
bypass policy for the refusal — `bypass: allow` means "run this Git command
anyway", and this one has no command to run. The guard judges the session root
(or the tool call's `workdir`, which the harness resolves before the command
runs), not a `cd` inside the command text, so `cd ../other-jj && jj log` is
refused even though it would work; `-R` (or `workdir`) is the supported way to
point at another workspace. It saves a failed call; it does not confine a
session ([SPEC §5.15](../SPEC.md)).

## (b) The corpus, with results

### Method

Two independent measurements, because the probe and the truth must not share an
assumption:

1. **Probe result** — `node scripts/probe-invocation.mjs`, the table below.
2. **What it really does** — a scratch colocated `jj` repo in `/tmp` with a
   `git` shim first on `PATH` that appends its argv to a log and exits 1. Every
   command was run as `bash -c '<command>'` with that `PATH`; "invoked" means
   the shim logged. **57 of 64** were executed this way; 5 are marked
   _(reasoned)_ (see caveats); 1 (`rm -rf .git`) is excluded because it destroys
   the fixture and is measured separately in (e).

Caveats on the truth harness, all verified: the shim is **invisible** to
`bash -lc "…"` (a login shell resets `PATH`), to `env -i git …` (the default
`PATH` still finds `/usr/bin/git`), to an absolute path, and to
`PATH=/usr/bin:$PATH git …`. For those rows the "really does" column comes from
the observed output (`git version 2.54.0 (Apple Git-157)`, `fatal: No configured
push destination.`), not from the shim log.

### Summary

| Metric                                            | Count  |
| ------------------------------------------------- | ------ |
| Commands                                          | 64     |
| Correct                                           | 54     |
| **False negatives** (real Git runs, probe allows) | **10** |
| **False positives** (probe denies, no Git runs)   | **0**  |
| Low confidence                                    | 16     |

All 10 false negatives carry `confidence: 'low'`. No false negative is silent.

### The table

`probe result` is verbatim from the run; `conf.` is the probe's confidence;
`ok?` is this doc's judgement, not the program's.

| #   | command                                                            | what it really does                                                                             | probe result                           | verdict        | conf. | ok?    |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------- | -------------- | ----- | ------ |
| 1   | `git status`                                                       | Git runs; in a colocated repo it reads jj-maintained state                                      | git: `git status`                      | correct        | high  | yes    |
| 2   | `git commit -m x`                                                  | Git commits; jj then re-parents the working copy                                                | git: `git commit -m x`                 | correct        | high  | yes    |
| 3   | `git commit -m "x" && git push`                                    | two Git invocations joined by &&                                                                | git: `git commit -m "x"`, `git push`   | correct        | high  | yes    |
| 4   | `cd /tmp && git log`                                               | Git outside the workspace                                                                       | git: `git log`                         | correct        | high  | yes    |
| 5   | `git status; jj log`                                               | Git then jj; only the first is a violation                                                      | git: `git status`                      | correct        | high  | yes    |
| 6   | `git --version`                                                    | Git with no subcommand                                                                          | git: `git --version`                   | correct        | high  | yes    |
| 7   | `git status 2>&1 \| tee log`                                       | redirection and a pipe after the program                                                        | git: `git status 2>&1`                 | correct        | high  | yes    |
| 8   | `command git status`                                               | `command` bypasses functions/aliases, still runs Git                                            | git: `command git status`              | correct        | high  | yes    |
| 9   | `env FOO=1 git push`                                               | env execs Git with an extra variable                                                            | git: `env FOO=1 git push`              | correct        | high  | yes    |
| 10  | `env -i git status`                                                | clears the environment, but the default PATH still finds /usr/bin/git                           | git: `env -i git status`               | correct        | high  | yes    |
| 11  | `nohup git fetch`                                                  | nohup execs Git                                                                                 | git: `nohup git fetch`                 | correct        | high  | yes    |
| 12  | `time git log`                                                     | the `time` keyword runs Git                                                                     | git: `time git log`                    | correct        | high  | yes    |
| 13  | `sudo git status`                                                  | sudo execs Git as root _(reasoned)_                                                             | git: `sudo git status`                 | correct        | high  | yes    |
| 14  | `exec git status`                                                  | exec replaces the shell with Git                                                                | git: `exec git status`                 | correct        | high  | yes    |
| 15  | `nice git log`                                                     | nice execs Git                                                                                  | git: `nice git log`                    | correct        | high  | yes    |
| 16  | `nice -n 10 git log`                                               | `-n 10` belongs to nice, not to the program                                                     | git: `nice -n 10 git log`              | correct        | high  | yes    |
| 17  | `sudo -u root -- git push`                                         | sudo flag, value and `--` before the program _(reasoned)_                                       | git: `sudo -u root -- git push`        | correct        | high  | yes    |
| 18  | `sudo sh -c 'git push'`                                            | wrapper, then a nested shell body _(reasoned)_                                                  | git: `git push`                        | correct        | high  | yes    |
| 19  | `env FOO=1 sh -c "git push"`                                       | assignment, wrapper, nested shell                                                               | git: `git push`                        | correct        | high  | yes    |
| 20  | `\git status`                                                      | backslash suppresses alias/function lookup, runs the binary                                     | git: `\git status`                     | correct        | high  | yes    |
| 21  | `FOO=1 BAR=2 git status`                                           | bare assignments prefix a simple command                                                        | git: `FOO=1 BAR=2 git status`          | correct        | high  | yes    |
| 22  | `/usr/bin/git status`                                              | Apple Git at an absolute path _(reasoned)_                                                      | git: `/usr/bin/git status`             | correct        | high  | yes    |
| 23  | `/opt/homebrew/bin/git --version`                                  | Homebrew Git at an absolute path _(reasoned)_                                                   | git: `/opt/homebrew/bin/git --version` | correct        | high  | yes    |
| 24  | `./git status`                                                     | a relative path to a binary named git                                                           | git: `./git status`                    | correct        | high  | yes    |
| 25  | `git-lfs pull`                                                     | a different binary; it internally execs `git version` and `git rev-parse` (observed)            | no git invocation                      | correct        | high  | yes    |
| 26  | `jj-hunk list`                                                     | a different binary again                                                                        | no git invocation                      | correct        | high  | yes    |
| 27  | `sh -c 'git commit'`                                               | the nested body is the command                                                                  | git: `git commit`                      | correct        | high  | yes    |
| 28  | `bash -lc "git push"`                                              | login shell resets PATH, then the -c body runs Git                                              | git: `git push`                        | correct        | high  | yes    |
| 29  | `zsh -c 'git status'`                                              | zsh nested body                                                                                 | git: `git status`                      | correct        | high  | yes    |
| 30  | `bash -c 'echo hi; git status'`                                    | two commands inside one nested body                                                             | git: `git status`                      | correct        | high  | yes    |
| 31  | `eval 'git log'`                                                   | eval parses its argument as a command                                                           | git: `git log`                         | correct        | high  | yes    |
| 32  | `echo "v=$(git rev-parse HEAD)"`                                   | substitution runs Git although the head program is echo                                         | git: `git rev-parse HEAD`              | correct        | high  | yes    |
| 33  | ``echo "v=`git rev-parse HEAD`"``                                  | same, with backticks                                                                            | git: `git rev-parse HEAD`              | correct        | high  | yes    |
| 34  | `echo "$(echo git)"`                                               | a substitution that never invokes Git                                                           | no git invocation                      | correct        | high  | yes    |
| 35  | `g=git; $g status`                                                 | the program name comes from a variable                                                          | no git invocation                      | false negative | low   | yes    |
| 36  | `alias gs='git status'; gs`                                        | aliases are off in a non-interactive shell, so `gs` runs Ghostscript (which is on PATH) instead | no git invocation                      | correct        | low   | yes    |
| 37  | `shopt -s expand_aliases; alias gs='git status'; gs`               | still no alias expansion: with `;` the whole line is parsed before the alias exists             | no git invocation                      | correct        | low   | yes    |
| 38  | `shopt -s expand_aliases\nalias gs='git status'\ngs`               | on separate input lines the alias is defined before use, and really runs Git                    | no git invocation                      | false negative | low   | yes    |
| 39  | `echo hi \| xargs git add`                                         | xargs execs Git on the piped input                                                              | git: `xargs git add`                   | correct        | low   | yes    |
| 40  | `printf 'a\n' \| xargs -n1 git add`                                | xargs with a flag before the program                                                            | git: `xargs -n1 git add`               | correct        | low   | yes    |
| 41  | `find . -exec git status \;`                                       | find -exec runs Git                                                                             | git: `find . -exec git status \;`      | correct        | high  | yes    |
| 42  | `git() { command git "$@"; }`                                      | a definition is inert; nothing runs                                                             | no git invocation                      | correct        | low   | yes    |
| 43  | `git() { command git "$@"; }; git status`                          | the call runs the function, which reaches the real Git via `command`                            | no git invocation                      | false negative | low   | yes    |
| 44  | `make commit`                                                      | the Makefile target shells out to Git                                                           | no git invocation                      | false negative | low   | yes    |
| 45  | `./scripts/commit.sh`                                              | the script shells out to Git                                                                    | no git invocation                      | false negative | low   | yes    |
| 46  | `bash scripts/release.sh`                                          | bash runs a file that shells out to Git                                                         | no git invocation                      | false negative | low   | yes    |
| 47  | `npm run release`                                                  | the package.json script shells out to Git                                                       | no git invocation                      | false negative | low   | yes    |
| 48  | `npm run git:check`                                                | a script whose _name_ contains git; its body is echo                                            | no git invocation                      | correct        | low   | yes    |
| 49  | `python3 scripts/deploy.py`                                        | the Python file spawns Git                                                                      | no git invocation                      | false negative | low   | yes    |
| 50  | `python3 -c "import subprocess; subprocess.run(['git','status'])"` | Python spawns Git                                                                               | no git invocation                      | false negative | low   | yes    |
| 51  | `node -e "require('child_process').execSync('git status')"`        | Node spawns Git                                                                                 | no git invocation                      | false negative | low   | yes    |
| 52  | `git -C /tmp status`                                               | `-C` changes directory; still Git                                                               | git: `git -C /tmp status`              | correct        | high  | yes    |
| 53  | `echo "git commit -m x"`                                           | a string argument                                                                               | no git invocation                      | correct        | high  | yes    |
| 54  | `echo git`                                                         | git as an argument                                                                              | no git invocation                      | correct        | high  | yes    |
| 55  | `grep -rn "git status" docs/`                                      | a grep pattern                                                                                  | no git invocation                      | correct        | high  | yes    |
| 56  | `cat .git/config`                                                  | a path containing `.git`                                                                        | no git invocation                      | correct        | high  | yes    |
| 57  | `jj git export`                                                    | jj subcommand; jj does not exec the git binary                                                  | no git invocation                      | correct        | high  | yes    |
| 58  | `jj git push`                                                      | jj subcommand                                                                                   | no git invocation                      | correct        | high  | yes    |
| 59  | `jj config get git.executable-path`                                | a jj subcommand whose argument is a config key containing the token git                         | no git invocation                      | correct        | high  | yes    |
| 60  | `# git commit -m x`                                                | a whole-line comment                                                                            | no git invocation                      | correct        | high  | yes    |
| 61  | `echo hi # git commit`                                             | a trailing comment                                                                              | no git invocation                      | correct        | high  | yes    |
| 62  | `if git status; then echo ok; fi`                                  | Git in an if-condition                                                                          | git: `if git status`                   | correct        | high  | yes    |
| 63  | `(git status)`                                                     | a subshell                                                                                      | git: `(git status)`                    | correct        | high  | yes    |
| 64  | `rm -rf .git`                                                      | deletes the Git directory; invokes no git program at all                                        | no git invocation                      | correct        | high  | **NO** |

### The 10 false negatives, and why none of them is silent

Verbatim from the run's notes block (low-confidence rows only):

```
- `g=git; $g status` — variable expansion in program position: `$g`
- `alias gs='git status'; gs` — `alias` changes shell name resolution (aliases/options) which is not modeled
- `shopt -s expand_aliases; alias gs='git status'; gs` — `shopt` … ; `alias` …
- `shopt -s expand_aliases\nalias gs='git status'\ngs` — `shopt` … ; `alias` …
- `echo hi | xargs git add` — `xargs` — the program it runs is assembled from stdin; detection here is best-effort
- `printf 'a\n' | xargs -n1 git add` — `xargs` — …
- `git() { command git "$@"; }` — shell function definition `git` — later calls … ; body not analyzed
- `git() { command git "$@"; }; git status` — … ; `git` is also defined as a shell function …
- `make commit` — `make` dispatches to a target defined outside the command text
- `./scripts/commit.sh` — `commit.sh` is a script file — contents not read
- `bash scripts/release.sh` — `bash` runs a script file — contents not read
- `npm run release` — `npm` dispatches to a target defined outside the command text
- `npm run git:check` — `npm` dispatches to a target defined outside the command text
- `python3 scripts/deploy.py` — `python3` runs a file whose contents are not analyzed
- `python3 -c "import subprocess; subprocess.run(['git','status'])"` — `python3 -c` — inline code is not analyzed
- `node -e "require('child_process').execSync('git status')"` — `node -e` — inline code is not analyzed
```

(The notes block has 16 rows; 6 of them — `alias`/`shopt`, `xargs`, and the
inert function definition — are rows where the probe is _correct_ and merely
cautious. Only the 10 listed in the summary as false negatives are real misses.)

### What the corpus corrected in the earlier docs

| Earlier claim                                                                              | Measured                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `jj log -r 'git_head()'` is a valid revset containing `git`                                | **CONTRADICTED.** `Error: Failed to parse revset: Function \`git_head\` doesn't exist`. `jj help -k revsets`documents no`git`-prefixed revset function. (It does mention `git`eleven times — all comparisons to`git log`, Git-tracking bookmarks, and `github.com`URLs — so the claim is about function names, not about the string.) Replaced in the corpus with`jj config get git.executable-path`. | [15 §4](15-verb-mapping.md)                                          |
| `xargs git` should be allowed because treating `xargs` as a wrapper causes false positives | **PARTLY CONTRADICTED.** Treating `xargs` as a wrapper produced **0** false positives in 64 commands and two true positives. The probe detects it and flags low confidence.                                                                                                                                                                                                                           | [15 §4](15-verb-mapping.md)                                          |
| `find … -exec git …` is an uncatchable false negative                                      | **CONTRADICTED.** The token after `-exec` is the program by definition; the probe resolves it statically, high confidence.                                                                                                                                                                                                                                                                            | [12 §B](12-risks-and-open-questions.md), [15 §4](15-verb-mapping.md) |
| `alias gs='git status'; gs` really runs Git                                                | **CONTRADICTED for `;`.** In a non-interactive `bash -c`, no alias expansion happens and `gs` resolves to **Ghostscript** on `PATH`. Only the multi-line `shopt -s expand_aliases` + newline-separated form runs Git. The class is narrower than documented.                                                                                                                                          | [12 §B](12-risks-and-open-questions.md), [15 §4](15-verb-mapping.md) |
| A `PATH` shim "would break the `jj git export` bridge"                                     | **CONTRADICTED.** `jj git export` never execs Git — 0 shim hits, colocated _and_ non-colocated. But `jj git fetch` and `jj git push` **do**. See (d).                                                                                                                                                                                                                                                 | [12 §B](12-risks-and-open-questions.md)                              |

## (c) The residual gaps, ranked

Ranked by likelihood × harm, for a **cooperative** model in a `jj` workspace.
"Caught here?" means at the command-text layer.

| Rank  | Class                                           | Examples                                                                                                        | Caught here?                                                                                                                                                       | What would catch it                                                                                                               | L   | H   | L×H    |
| ----- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ------ |
| **1** | **Destructive path operations on VCS metadata** | `rm -rf .git`, `rm -rf .jj`, `mv .git …`, `> .git/HEAD`, `truncate -s0 .git/HEAD`, `find .git -delete`          | **No — wrong rule.** The program resolves to `rm`/`mv`/`truncate`/`find` (or to nothing, for a bare redirection). All 9 variants tested: allowed, high confidence. | A **destructive-path rule** keyed on the _path argument_, not the program. See (e).                                               | 3   | 5   | **15** |
| **2** | **Script / task-runner indirection**            | `make commit`, `npm run release`, `./scripts/commit.sh`, `bash scripts/release.sh`, `python3 scripts/deploy.py` | No — but **flagged low confidence**.                                                                                                                               | Reading the file/target. Out of scope: needs filesystem + a build-graph model. The cheap substitute is low-confidence→ask, below. | 3   | 4   | **12** |
| **3** | **Interpreter inline code**                     | `python3 -c "…subprocess.run(['git',…])"`, `node -e "…execSync('git status')"`                                  | No — flagged low confidence.                                                                                                                                       | Nothing cheap; the code is an opaque string. Low-confidence→ask.                                                                  | 1   | 4   | 4      |
| **4** | **Variable in program position**                | `g=git; $g status`                                                                                              | No — flagged low confidence.                                                                                                                                       | Nothing; the value is computed at run time. Low-confidence→ask.                                                                   | 1   | 3   | 3      |
| **5** | **Function named `git`**                        | `git() { command git "$@"; }; git status`                                                                       | **Deliberately not**, and flagged. A definition alone is inert (verified: 0 Git execs); a later call to that name is ambiguous.                                    | Nothing. Adversarial-only; the cooperative model does not do this.                                                                | 1   | 2   | 2      |
| **6** | **Aliases**                                     | `alias gs='git status'; gs`                                                                                     | No — flagged. Mostly moot: verified not to expand in a `bash -c` one-liner.                                                                                        | Nothing. Only the multi-line `expand_aliases` form works.                                                                         | 1   | 2   | 2      |

**Not gaps, despite the framing in [12 §B](12-risks-and-open-questions.md):**

| Command                               | Why it is not a gap                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env -i git status`                   | The guard resolves the **program name from the text**, so a cleared/rewritten `PATH` is irrelevant. The shim in (d) misses this; the guard does not. |
| `bash -lc "git push"`                 | Same: `-c` bodies are recursed into, so a login shell's `PATH` reset does not matter.                                                                |
| `/usr/bin/git status`, `./git status` | Basename resolution catches both.                                                                                                                    |
| `echo hi \| xargs git add`            | Wrapper stripping catches it (low confidence).                                                                                                       |

**Top recommendation for the residual gaps.** Two changes, in this order:

1. **Add a destructive-path rule** for `.git`/`.jj` (rank 1). It is the only
   residual with unrecoverable harm, and it is cheap: a path-shaped match on
   destructive verbs. It is _not_ part of the Git-verb guard. See (e).
2. **Treat `confidence: 'low'` as a policy input: ask, do not allow.** A
   cooperative model that emits `make commit` is exactly the case where a human
   one-second decision beats a guess. Under a `never` approval policy, ask
   degrades to the harness's own rejection text ([17](17-bypass-and-approval.md)),
   so low confidence must then **deny with our own reason** — the same
   `policy === 'never'` branch [17](17-bypass-and-approval.md) already defines.

   Cost, stated honestly: this prompts on `npm run test` and `make build` in a
   `jj` workspace, because every task runner is low confidence. If that is too
   noisy, narrow it to runners whose _target name_ matches a Git verb
   (`commit|push|pull|fetch|release|deploy|publish|tag|merge|rebase|reset`) —
   `make commit` asks, `make build` does not. That is a heuristic with its own
   false prompts, but a false prompt is cheaper than a missed `git push`.

## (d) Mitigations beyond text matching

### 1. A `git` shim earlier on `PATH`

**Measured**, not assumed. Shim = append argv to a log, exit 1.

```
$ jj git export                      # colocated, shim first on PATH
No export needed in colocated workspaces.        exit=0  shim_lines=0
$ jj git export                      # non-colocated
Nothing changed.                                 exit=0  shim_lines=0

$ jj git fetch                       # WITH shim
Error: Git process failed: External git program failed:   exit=1  shim_lines=1
  argv: git -c core.fsmonitor=false -c submodule.recurse=false \
        --git-dir <repo>/.git fetch --porcelain --prune \
        --no-write-fetch-head --no-tags -- origin +refs/heads/*:refs/remotes/origin/*
$ jj git fetch                       # WITHOUT shim
Nothing changed.                                 exit=0

$ jj git push --bookmark main        # WITH shim
Changes to push to origin:
  bookmark: main [add to 9e533f8fe933]
Error: Git process failed: External git program failed:   exit=1  shim_lines=1
  argv: git … --git-dir <repo>/.git push --porcelain --no-verify \
        --force-with-lease=refs/heads/main: -- origin <sha>:refs/heads/main

$ git-lfs pull                       # WITH shim
Error getting Git version: error running <shim> 'version': exit status 1   shim_lines=3
```

So the concern in [12 §B](12-risks-and-open-questions.md) is **half right and
pointed at the wrong command**: `jj git export`/`import`/`clone`/`init`/
`remote`/`root`/`status`/`log` never exec Git (0 shim hits across all of them),
but **`jj git fetch` and `jj git push` do**, and `git-lfs` does three times.

**The fix exists and works.** `git.executable-path` is a real `jj` config key
(`jj config list --include-defaults` → `git.executable-path = "git"`):

```
$ jj --config git.executable-path=/opt/homebrew/bin/git git fetch   # shim still first on PATH
Nothing changed.                                 exit=0  shim_lines=0
```

| Property           | Assessment                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Robustness         | **Weak as a boundary.** Four verified bypasses, all one token: `bash -lc "git …"` (login shell resets `PATH`), `env -i git …` (default `PATH` → `/usr/bin/git`), `PATH=/usr/bin:$PATH git …`, and any absolute path. Against the cooperative model it is fine; against a hostile one it is decoration. |
| Invasiveness       | **High.** The shim must be injected into the `bash` tool's environment, so it applies to every process the agent starts — and to anything else sharing that environment.                                                                                                                               |
| Breaks other tools | **Yes, two verified:** `jj git fetch`/`push` (fixed by setting `git.executable-path`) and `git-lfs` (no fix — it hard-requires a working `git`). `jj git export` is **not** broken.                                                                                                                    |
| Verdict            | **Do not ship as the enforcement mechanism.** If a shim is wanted anyway, it must ship with `git.executable-path` set, must accept broken `git-lfs`, and must be documented as best-effort.                                                                                                            |

### 2. `GIT_DIR` / `GIT_WORK_TREE` manipulation

Point `GIT_DIR` at a nonexistent path so every `git` fails with "not a git
repository".

| Property           | Assessment                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robustness         | **Worse than the shim.** The same four bypasses, plus `env -u GIT_DIR git …`, `git --git-dir=…`, and `unset GIT_DIR` at the head of the same command. **UNVERIFIED / reasoned** — this mitigation was not implemented, so these are POSIX/bash reasoning, not executed evidence. |
| Invasiveness       | **High.** Leaks into every child process, including editors and build tools that legitimately read `.git` ([10](10-workflow-compatibility.md), [12 §A](12-risks-and-open-questions.md)).                                                                                         |
| Breaks other tools | `git-lfs` again; anything inheriting the environment. `jj`'s own external-git calls survive because jj passes `--git-dir <path>` explicitly (visible in the argv above), which overrides `GIT_DIR`.                                                                              |
| Failure quality    | Worst of the three: the model sees `fatal: not a git repository`, which teaches it nothing about `jj`.                                                                                                                                                                           |
| Verdict            | **Rejected.** Same bypasses, more collateral, no message.                                                                                                                                                                                                                        |

### 3. Context injection

The interface is `ctx.inject(["systemPrompt"], scope => …)` with
`scope.systemPrompt.section({…})` / `.context({…})`; [22](22-context-injection.md)
owns it and this doc does not restate it.

| Property           | Assessment                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robustness         | **Not an evasion defence at all** — it changes what the model _wants_ to emit, not what runs. It removes the ordinary case (habit) and does nothing for the adversarial case.                                                                        |
| Invasiveness       | Low: a prompt section, no environment change.                                                                                                                                                                                                        |
| Breaks other tools | No.                                                                                                                                                                                                                                                  |
| Verdict            | **Recommended, and the highest-leverage layer.** It is the only mitigation that prevents the command instead of reacting to it. It complements the guard; it does not replace it (a model can still emit `git` while believing it is in a Git repo). |

### 4. Allow, then correct via `tools/post-execute {kind:'block', feedback}`

The channel is documented in [02](02-git-blocking-at-tool-call-level.md)
(the end-to-end flow is **UNVERIFIED** there, as the `ask` path also is in
[17](17-bypass-and-approval.md)).

| Property           | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robustness         | **Perfect by construction** — there is no evasion, because the command really runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Invasiveness       | Low for the harness; **high for the repository**, because the command's effect is real before the feedback arrives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Breaks other tools | No.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Verdict            | **Recommended for the read-only subset only** (`git status`, `git log`, `git diff`, `git show`, `git branch`, `git blame`). Those are harmless, their output is genuinely informative, and the corrective feedback lands with real output to anchor it. For mutating verbs, `git commit` re-parents the jj working copy ([15 §3.2](15-verb-mapping.md)) and `git reset --hard` destroys edits, so pre-execute deny stays. [17](17-bypass-and-approval.md) already makes this a config choice via `readOnlyGit`. **Declined downstream:** [14 R10](14-decision-log.md) keeps read-only Git on `pre-execute`, on the grounds that the command's _output_ is the harm and that running it to withhold the result is strictly worse than denying. That supersedes this row. |

### 5. Do nothing about the residual; rely on `jj op restore`

| Property           | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robustness         | **Good for the Git-verb class.** `jj op restore` is real (`jj op restore --help`: "Create a new operation that restores the repo to an earlier state") and jj's op log is append-only, so the state before a stray `git` command is still in the log. **UNVERIFIED end to end** — the command and the log were confirmed, but a recovery of a `git commit`-induced re-parent ([15 §3.2](15-verb-mapping.md)) was not actually performed. |
| Robustness for (e) | **Zero.** After `rm -rf .git` in a colocated repo, `jj op log` itself fails, so `jj op restore` cannot run. Verified in (e).                                                                                                                                                                                                                                                                                                             |
| Invasiveness       | None.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Breaks other tools | No.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Verdict            | **Acceptable as the fallback** for the low-confidence indirect class — those commands are flagged, rare, and recoverable. **Not** an answer to the destructive-path class.                                                                                                                                                                                                                                                               |

### Recommendation

| Layer                 | Decision                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prevention            | Ship context injection ([22](22-context-injection.md)).                                                                                                                                                                                                                                                                 |
| Detection             | Ship the program-resolving guard ([15 §2](15-verb-mapping.md), prototyped here). Across the 64-command corpus it produces **0 false positives**, and its 10 false negatives are all flagged low-confidence. It is also robust to the `PATH` tricks that defeat a shim, because it reads the program name from the text. |
| Read-only Git         | Post-execute `{kind:'block', feedback}` was recommended here; **declined** by [14 R10](14-decision-log.md) — read-only Git stays on `pre-execute`.                                                                                                                                                                      |
| Low confidence        | Ask; deny with our own reason under `never`.                                                                                                                                                                                                                                                                            |
| `PATH` shim           | **Do not ship.** It breaks `jj git fetch`/`push` and `git-lfs`, and it is bypassed by `bash -lc`, `env -i`, and any absolute path. Adopted as [14 R8](14-decision-log.md).                                                                                                                                              |
| `GIT_DIR`             | **Do not ship.** Same bypasses, more collateral, worse message. Adopted as [14 R8](14-decision-log.md).                                                                                                                                                                                                                 |
| `rm -rf .git` / `.jj` | A separate destructive-path predicate, not part of this guard. Adopted as [14 R9](14-decision-log.md), specified in `SPEC.md` §5.7.                                                                                                                                                                                     |
| Recovery              | Document `jj op restore` as the recovery path for everything _except_ `.git`/`.jj` deletion, where there is none.                                                                                                                                                                                                       |

## (e) The `rm -rf .git` class

### It is a genuine hole, and the damage is unrecoverable

`rm -rf .git` invokes no Git program (shim: **0 lines**), so a rule that resolves
the invoked program allows it with **high confidence** — row 64. In a colocated
repo that is the single most destructive command available:

```
before: commits=2  .git=yes  .jj=yes
$ rm -rf .git                 exit=0  shim_lines=0
after:  .git=no   .jj=yes

$ jj status
Internal error: The repository appears broken or inaccessible
Caused by: 1: Failed to open git repository
$ jj log --no-graph -r "all()"      → same error
$ jj op log --no-graph              → same error
$ jj git init --colocate
Error: The target repo already exists
$ git init -q .        # recreate an empty .git, then retry
$ jj status
Internal error: Unexpected error from backend
Caused by: Object f5b29dc23df2567748b6e01c2adc981b9ff920c4 of type commit not found
```

Why nothing recovers it:

| Fact                                                                                                                                       | Consequence                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| In a colocated repo, `.jj/repo/` holds the op store (`op_store`, `op_heads`, `workspace_store`) but the **commit objects live in `.git`**. | Deleting `.git` deletes the object store that the jj backend reads.   |
| `jj status`, `jj log`, `jj op log` all fail with "Failed to open git repository".                                                          | `jj op restore` exists but **cannot run** — the op log is unreadable. |
| `jj git init --colocate` → `Error: The target repo already exists`.                                                                        | The obvious repair command refuses, because `.jj` survives.           |
| Recreating `.git` with `git init` → `Object … not found`.                                                                                  | The history is gone, not merely disconnected.                         |

**In a non-colocated repo the same command is a no-op** — `jj git init
--no-colocate` creates `.jj` only, there is no `.git`, and `rm -rf .git` changes
nothing (verified). The hole is specific to colocated repos, which is the
deployment this project recommends ([07](07-jujutsu-core-model.md),
[10](10-workflow-compatibility.md)).

`rm -rf .jj` is the mirror image: in a non-colocated repo it destroys the store
(shim: 0 lines; after it, `jj log` → `Error: There is no jj repo in "."`).

### What should happen

**It belongs to the `.jj`/`.git` write-protection rule, not to this guard.**
The Git-verb guard's entire correctness argument is "resolve the _program_,
never scan for a token" ([15 §2](15-verb-mapping.md)). A path-shaped rule is a
different question about the same command string, and folding it in would mean
re-introducing token matching into a rule whose value is that it does not do
that. [12 §G](12-risks-and-open-questions.md) already anticipated the rule for
`read`/`write`/`edit` on `.jj/` internals; this is the same rule reaching
`bash`.

Recommended shape:

| Aspect            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam              | Same `tools/pre-execute` listener, separate predicate and separate `reason`.                                                                                                                                                                                                                                                                                                                                                                         |
| Trigger           | A destructive verb (`rm`, `rmdir`, `mv`, `truncate`, `shred`, `>`, `find … -delete`) whose **resolved path argument** names the exact component `.git` or `.jj` (trailing slash allowed).                                                                                                                                                                                                                                                            |
| Not a trigger     | `.gitignore`, `.gitattributes`, `.gitkeep`, `git` (the file), `.github/` — match the component exactly, never a prefix. All eight `rm`-based variants (these five plus `rm -rf .git`, `rm -rf .git/`, `rm -rf ./x/.git`) were run through the probe: every one resolves to program `rm` with high confidence, so **the probe cannot make this distinction** — it is a property of the path predicate, and it is the whole reason the rule needs one. |
| Unresolvable path | `rm -rf "$PWD/.git"`, `rm -rf $(jj workspace root)/.git` — the path is computed. Note the probe reports these as _high_ confidence, because it judges program resolution, not path resolution: `rm -rf $(jj workspace root)/.git` yields `programs=[jj, rm]`. The destructive-path rule therefore needs its own resolvability notion and must ask (never allow) when a path argument contains an expansion.                                          |
| Heredoc bodies    | A quoted heredoc body with no stdin executor on the opening line is masked before the scan: writing a document that merely _mentions_ `` `rm -rf .git` `` is not an operand. `bash <<'EOF'` still shows its script, and an unquoted body is still scanned because it expands. Same `maskHeredocData` rule as the invocation resolver, covered by `test/heredoc.test.ts`.                                                                             |
| Posture           | Same matrix as [17](17-bypass-and-approval.md): `ask` when a human is present (de-colocating a repo is a legitimate, deliberate act), `deny` with our own reason under `never`.                                                                                                                                                                                                                                                                      |
| Message           | Must say that the operation is **unrecoverable** and name the non-destructive alternative (`jj git colocation disable` to de-colocate, `jj workspace add` for a second working copy). Not a Git-verb mapping — there is no `jj` verb that restores a deleted object store.                                                                                                                                                                           |
| Scope             | `bash` at minimum; the same predicate should cover `write`/`edit` targets under `.jj/`, per [12 §G](12-risks-and-open-questions.md).                                                                                                                                                                                                                                                                                                                 |

## Verification status

| Claim                                                                                                                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 64-command corpus table, counts, and confidence flags                                                                       | **VERIFIED** — `node scripts/probe-invocation.mjs` output pasted verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The "what it really does" column                                                                                                | **VERIFIED by execution** for 57 commands (logging `git` shim on `PATH` in a `/tmp` colocated `jj` repo); 5 marked _(reasoned)_ (3 × `sudo`, 2 × absolute path) because a password prompt and an absolute path are not observable through the shim.                                                                                                                                                                                                                                                                                  |
| Shim bypasses: `bash -lc`, `env -i`, `PATH=/usr/bin:$PATH`, absolute path                                                       | **VERIFIED** — each printed `git version 2.54.0 (Apple Git-157)` with the shim first on `PATH`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `jj git export`/`import`/`clone`/`init`/`remote`/`root`/`status`/`log` never exec Git                                           | **VERIFIED** — 0 shim lines across all of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `jj git fetch` / `jj git push` exec the external `git` program, argv captured                                                   | **VERIFIED** — see (d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `git.executable-path` restores `jj git fetch` under a shim                                                                      | **VERIFIED** — `jj --config git.executable-path=/opt/homebrew/bin/git git fetch` → `Nothing changed.`, 0 shim lines.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `git-lfs` execs `git version`, `git rev-parse --git-dir`, `git remote`                                                          | **VERIFIED** — 3 shim lines; with the shim, `git-lfs pull` fails with `Error getting Git version`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rm -rf .git` damage and non-recoverability                                                                                     | **VERIFIED** — full sequence in (e).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rm -rf .git` in a non-colocated repo is a no-op                                                                                | **VERIFIED**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Alias expansion needs a previous input _line_, not a `;`                                                                        | **VERIFIED** — `;` form ran Ghostscript's `gs`; newline form ran the shim.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `git_head()` is not a jj revset function in 0.46                                                                                | **VERIFIED** — `jj help -k revsets` documents no `git`-prefixed function; its eleven `git` mentions are `git log` comparisons, Git-tracking bookmarks and GitHub URLs. The function itself errors: `Function \`git_head\` doesn't exist`.                                                                                                                                                                                                                                                                                            |
| `tools/pre-execute` deny/ask contract, `post-execute {kind:'block'}`, approval policy matrix                                    | **VERIFIED elsewhere** — [02](02-git-blocking-at-tool-call-level.md), [11](11-verified-dsh-api-contract.md), [17](17-bypass-and-approval.md). Not re-tested here.                                                                                                                                                                                                                                                                                                                                                                    |
| End-to-end ask-then-run and post-execute block flows                                                                            | **UNVERIFIED** — not exercised in this session; [17](17-bypass-and-approval.md) flags the same gap.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The probe's behaviour on inputs outside the corpus (heredocs, `coproc`, `$((…))`, process substitution, `set -e`, `trap DEBUG`) | **PARTLY VERIFIED.** A quoted heredoc body (`<<'EOF'`) whose opening line names no stdin executor is blanked before analysis — the body is data, so its Markdown prose and backticks cannot invent a Git invocation (`maskDataHeredocBodies` in `src/invocation.ts`, `test/heredoc.test.ts`). A shell-fed body (`bash <<'EOF'`, `cat <<'EOF' \| zsh`, `ssh host <<'EOF'`) is still scanned; **unquoted** bodies, `coproc`, `$((…))`, process substitution, `set -e` and `trap DEBUG` remain out of scope, as the module header says. |

**Scratch cleanup:** every fixture above lived under `/tmp/probe-truth` and was
removed after the runs.
