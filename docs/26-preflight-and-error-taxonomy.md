# 26 — Preflight and error taxonomy

**Status:** specification. Nothing here is implemented.
**Scope:** every environmental precondition the plugin checks, every error code
it can produce, and the fail-open / fail-closed posture of each.
**Toolchain measured against:** `jj` 0.46.0 (`/opt/homebrew/bin/jj`),
`jj-hunk` 0.5.1 (`~/.cargo/bin/jj-hunk`), `cargo` 1.99.0.
Every command in this document was run on this machine unless marked
**UNVERIFIED**. Part D is the index of what was and was not executed.

Related: [SPEC §5.1](../SPEC.md), [§5.4](../SPEC.md), [§8](../SPEC.md),
[§9](../SPEC.md) · [11](11-verified-dsh-api-contract.md) ·
[13](13-empirical-verification.md) · [18](18-tool-surface.md) ·
[19](19-jj-hunk-provisioning.md).

---

## 0. Two error channels — and why the code is not always visible

The plugin can fail through two different seams, and they do not carry the same
payload. This constrains every message below.

| Channel                                       | Shape                                                   | What the model sees       | What is durable-only |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------- | -------------------- |
| Guard (`tools/pre-execute` → `{kind:'deny'}`) | `{ kind:'deny', reason: string, info?: ToolErrorInfo }` | exactly `Error: <reason>` | `info`               |
| Tool body (any `jj_*` tool)                   | returned value `{ error: { code, message, hint? } }`    | the whole object          | —                    |

**VERIFIED** — `dsh-tools/lib/index.js:3241-3256`: the deny path builds
`{ content:[{type:'text', text: \`Error: ${denialReason}\`}], isError:true, error:{ message, info } }`.
`ToolErrorInfo`is`{ name, code, reason? }` (`dsh-tools/lib/types/index.d.ts:378`).

Two consequences that shape everything below:

1. A guard denial **cannot** show the model a `code` field. If the code matters
   for self-correction it must be spelled into `reason`. `info.code` is for
   durable diagnostics, not for the model.
2. A tool-body error is a **successful tool call** returning a value. The model
   sees `code` and `hint` as data, which is why the taxonomy below is built
   there and the guard is kept deliberately thin.

---

## Part A — Preflight checks

### A.1 The checks

| #       | Precondition                                | Probe                                                                            | On failure                                                                              | Posture                                                                            |
| ------- | ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **P1**  | `jj` resolvable                             | `command -v <jjPath>` (exit 1 = absent), then `jj --version`                     | `JJ_MISSING` on every `jj_*` tool                                                       | **closed** for tools · **open** for guard and `bash`                               |
| **P2**  | `jj` ≥ 0.46.0                               | parse `jj --version` → `jj 0.46.0`                                               | warn; see A.3                                                                           | **open** (warn) unless the capability probe fails, then **closed**                 |
| **P3**  | `jj-hunk` resolvable                        | `command -v <jjHunkPath>`, then `jj-hunk list --help`                            | `JJ_HUNK_MISSING` on the two hunk tools                                                 | **closed** for hunk tools · **open** everywhere else                               |
| **P4**  | `jj-hunk` ≥ 0.5.1                           | see A.4                                                                          | `JJ_HUNK_VERSION_TOO_OLD` if resolved; warn-and-proceed if unknown                      | **closed** when resolved too old · **open** when unresolvable                      |
| **P5**  | `cargo` present                             | `command -v cargo`                                                               | `CARGO_MISSING` — only the install _offer_ is disabled                                  | **open**                                                                           |
| **P6**  | `jj` identity configured                    | `jj config list user` — parse `user.name` **and** `user.email`                   | `JJ_IDENTITY_UNCONFIGURED`                                                              | **closed** for commit-creating ops · **open** + once-per-session warning otherwise |
| **P7**  | workspace root resolvable                   | `exec.agent?.session.header.cwd`                                                 | `WORKSPACE_ROOT_UNRESOLVED`                                                             | **open** for guard · **closed** for tools                                          |
| **P8**  | `.jj/` present and readable                 | `ctx.fs.stat(<root>/.jj)` → `{type:'directory'}`                                 | absent → `NOT_JJ_WORKSPACE` (plugin stays invisible); unreadable → `JJ_REPO_UNREADABLE` | **open** (absent) · **closed** for tools (unreadable)                              |
| **P9**  | repo not broken                             | resolve `.jj/repo` → read `store/git_target` → stat the named Git dir (A.2)      | `JJ_REPO_BROKEN`                                                                        | **closed** for tools · **open** for guard                                          |
| **P10** | colocated vs native                         | `.git` at root is `directory` / `file` / absent, cross-checked with `git_target` | not a failure — selects behaviour                                                       | n/a                                                                                |
| **P11** | remote configured                           | `jj git remote list`                                                             | not a failure — changes push guidance only                                              | **open**                                                                           |
| **P12** | conflicts present                           | `jj log --no-graph -T 'conflict' -r @` → `true`/`false`                          | not a failure — sets `conflicted` and warns                                             | **open** (warn)                                                                    |
| **P13** | primary vs secondary workspace              | is `.jj/repo` a directory or a file?                                             | not a failure — the real repo dir is indirect                                           | n/a                                                                                |
| **P14** | probe runs in the session's execution world | every probe through `ctx.shell`; never `process.env.PATH`                        | —                                                                                       | —                                                                                  |

P1–P6 are the ones with a _decision_ attached. P7–P13 are informational: they
change what the plugin says, not whether it works.

### A.2 The broken-repo probe (P9) is filesystem-only

`.jj/repo/store/git_target` is the authoritative colocation marker, and it is
readable without running `jj`:

```
$ cat <colocated>/.jj/repo/store/git_target     → ../../../.git
$ cat <native>/.jj/repo/store/git_target        → git
$ cat <colocated, .git deleted>/.../git_target  → ../../../.git   (unchanged)
```

So the check is: read `<repoDir>/store/git_target`; if the value is the literal
`git` the repo is native and nothing more is required; otherwise it is a
relative path — resolve it against `<repoDir>/store/` and `stat` it. Missing →
`JJ_REPO_BROKEN`.

**VERIFIED** on five fixtures (colocated primary, native primary, colocated
primary with `.git` deleted, secondary workspace, primary of a secondary pair).
**UNVERIFIED** on any `jj` other than 0.46.0: `git_target` is an internal layout
detail. Mitigation: treat a missing/unparseable `git_target` as _unknown_, not
as _broken_, and fall back to the shell probe
`jj status` → exit 255 + stderr `Internal error: The repository appears broken or inaccessible`.

**Measured failure text** (colocated, `rm -rf .git`):

```
$ jj status
Internal error: The repository appears broken or inaccessible
Caused by:
1: Failed to open git repository
2: "/tmp/<repo>/.git" does not appear to be a git repository
$ echo $?
255
```

Every `jj` read fails the same way: `jj log`, `jj op log`, `jj diff`,
`jj bookmark list` all exit **255** with that stderr and empty stdout. The
recovery command in [SPEC §5.7](../SPEC.md) is unavailable because the op log
itself is unreadable — `jj git init --colocate` answers `Error: The target repo
already exists`. There is no in-band repair.

A distinct, _recoverable_ failure is `.jj` present but unreadable:

```
$ chmod 000 .jj && jj status
Internal error: Failed to determine the secure config for a repo
Caused by:
1: Cannot access /tmp/<repo>/.jj/repo/config-id
$ echo $?
255
```

Same exit code, different first stderr line — which is why the two get separate
codes (`JJ_REPO_BROKEN`, `JJ_REPO_UNREADABLE`) and why the classification reads
stderr rather than the exit code.

### A.3 Version floor (P2)

`jj --version` is exactly `jj 0.46.0\n` — one space, three-part semver, nothing
else. Parse with `^jj (\d+)\.(\d+)\.(\d+)$`.

Below 0.46.0 the plugin does **not** refuse outright. The features that matter
are not the version number but two capabilities:

| Capability probe | Command                                  | Why                             |
| ---------------- | ---------------------------------------- | ------------------------------- |
| structured reads | `jj log --no-graph -T 'json(self)' -r @` | every `jj_*` read depends on it |
| conflict flag    | `jj log --no-graph -T 'conflict' -r @`   | P12                             |

If the version parses low but the probes pass, **warn once and proceed** — the
floor is what was tested, not what is required. If a probe fails, **refuse the
tools that need it** with `JJ_VERSION_TOO_OLD` and leave the guard and `bash`
untouched. What an actual older `jj` does is **UNVERIFIED**: no older binary is
installed and none was fetched.

### A.4 `jj-hunk` version detection (P4) — there is no version flag

This is the weakest check in the set, and it should be specified honestly.

**Measured:** `jj-hunk` has no version surface.

```
$ jj-hunk --version   → error: unexpected argument '--version' found
$ jj-hunk -V          → error: unexpected argument '-V' found
$ jj-hunk version     → error: unrecognized subcommand 'version'
$ strings ~/.cargo/bin/jj-hunk | grep -c '0\.5\.1'   → 0
```

The binary embeds no crate-version string (`strings` surfaces only dependency
versions such as `0.34.0`, `0.11.1`). Detection is therefore best-effort, in
three tiers:

| Tier | Method                                                                                                            | Reliability                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | `cargo install --list` → `jj-hunk v0.5.1 (https://github.com/laulauland/jj-hunk#53838e93):`                       | exact, but only for cargo-installed binaries                                           |
| 2    | capability probe: `jj-hunk list --format json` on a non-empty diff, assert every id matches `^hunk-[0-9a-f]{64}$` | proves the 0.5.1 ID contract; the discriminating power against 0.5.0 is **UNVERIFIED** |
| 3    | neither yields a version                                                                                          | version **unknown** → **proceed with a once-per-session warning**                      |

Tier 3 is the important one. Refusing a hunk operation because the _version
could not be read_ would block real work on a machine where the binary is
perfectly current — and the failure the floor protects against is
self-detecting anyway, because [SPEC §5.4](../SPEC.md) never accepts hunk IDs
across turns. The version gate is a courtesy, not a correctness boundary; the
`--query`/`--spec-template` capability probe is the correctness boundary.

`cargo install --list` output is verified:

```
jj-hunk v0.5.1 (https://github.com/laulauland/jj-hunk#53838e93):
    jj-hunk
```

### A.5 Identity (P6) — the measured case

**This is the highest-value check in the document.** Measured end to end.

#### The warning

Fresh repo, `JJ_CONFIG=/dev/null`, no identity, one commit:

```
$ jj git init && echo hello > a.txt && jj commit -m "first commit"
Working copy  (@) now at: nyykqlkr a26c31e4 (empty) (no description set)
Parent commit (@-)      : nlxmynxp 24d1febb first commit
Warning: Name and email not configured. Until configured, your commits will be created with the empty identity, and can't be pushed to remotes.
Hint: To configure, run:
  jj config set --user user.name "Some One"
  jj config set --user user.email "someone@example.com"
$ echo $?
0
```

**Exit 0.** The command succeeds. The warning goes to **stderr**, and so does
`jj commit`'s entire human output — `jj commit 2>/dev/null` produces _nothing_ on
stdout. A plugin that captures only stdout never sees this.

The commit is created with an empty identity, confirmed independently of the
warning text:

```
$ jj log --no-graph -T 'author.name() ++ "|" ++ author.email()' -r @-
|
$ jj log --no-graph -T 'json(self)' -r @-
{"commit_id":"24d1febb…","author":{"name":"","email":"","timestamp":"…"},
 "committer":{"name":"","email":"","timestamp":"…"}}
```

#### The commit cannot be pushed — verified against a real remote

`docs/13` §"What is still unverified" lists pushes as untested. This closes it
with a local bare repository as the remote:

```
$ git init --bare /tmp/<remote>
$ jj git remote add origin /tmp/<remote>
$ jj bookmark create main -r @-
$ jj git push --bookmark main
Error: Won't push commit c5aff5992944 since it has no author and/or committer set
Hint: Rejected commit: ursxowvm c5aff599 main | empty identity commit
$ echo $?
1
```

`jj` refuses **by itself**. No server, no hook, no network — the check is local.
So "unpushable" is not a prediction; it is `jj`'s own precondition.

#### Configuring later does not repair the past

```
$ JJ_CONFIG=/dev/null:<identity>.toml jj git push --bookmark main
Error: Won't push commit c5aff5992944 since it has no author and/or committer set
```

The identity is materialized when the commit is created. Every commit made
before the fix stays broken.

#### It _is_ repairable — which sets the posture

```
$ jj metaedit --update-author -r main
Modified 1 commits:
  ursxowvm 8faf8cf5 main* | empty identity commit
Rebased 1 descendant commits.
$ jj git push --bookmark main      → succeeds; the remote receives 8faf8cf5
```

Bulk repair is one revset, verified to select exactly the empty-identity
commits:

```
$ jj log --no-graph -T 'description.first_line()' -r 'author("")'
two one
```

#### The decision

**Refuse commit-creating operations; warn once per session everywhere else.**

| Operation                                                                         | Behaviour when identity is unconfigured                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `jj_status`, `jj_log`, `jj_diff`, `jj_op_log`, `jj_hunk_list`, `jj_bookmark list` | allow, attach a warning once per session                          |
| `jj_new`, `jj_hunk_apply` with `mode: split\|commit\|squash`                      | **refuse** — `JJ_IDENTITY_UNCONFIGURED`                           |
| `jj_describe`, `jj_squash`, `jj_op_restore`, `jj_bookmark` mutations              | allow, attach the warning — they do not mint a new empty identity |
| any `bash` call                                                                   | **never blocked** — see Part C                                    |

The line between the two rows is narrow and was measured, not assumed. The
identity is fixed when a commit is **created**; rewriting an existing commit
preserves its author.

| Command                 | In an unconfigured repo     | Author of the resulting commit      |
| ----------------------- | --------------------------- | ----------------------------------- |
| `jj new -m fresh`       | mints                       | **empty**                           |
| `jj commit -m x`        | mints                       | **empty**                           |
| `jj describe -m x`      | rewrites an existing commit | preserved (`real@example.com`)      |
| `jj squash` (jj-native) | rewrites the destination    | preserved (whatever it already had) |
| `jj-hunk split`         | mints                       | **empty**                           |
| `jj-hunk commit`        | mints                       | **empty**                           |
| `jj-hunk squash`        | mints                       | **empty**                           |

So `jj_squash` (the jj-native tool) is _not_ the same hazard as
`jj_hunk_apply` with `mode: squash` — the latter creates a commit and therefore
carries the identity precondition. That asymmetry is the reason the closed set
is `{jj_new, jj_hunk_apply(split|commit|squash)}` and not "everything that
mutates".

Why refuse rather than warn, given "fail open, deny narrowly":

- The failure is **silent** (exit 0), **permanent per commit**, and surfaces
  only at push time, which may be hours later or never.
- Refusing costs the user **nothing they did not already need to do**: without
  an identity there is no correct way to produce pushable history.
- A false refusal is impossible: the probe is a direct read of the config, and
  `JJ_USER`/`JJ_EMAIL` in the execution environment satisfy it (verified — the
  warning does not appear and the commit carries the env identity).
- The cost asymmetry is the whole argument. One wasted `jj_new` is a prompt;
  a dozen unpushable commits is a repair the user has to discover.

The `bash` path is deliberately exempt. The guard's contract is that it never
blocks the user's shell ([SPEC §8](../SPEC.md)), and denying `jj commit` typed
directly into `bash` would break the "invisible except for Git" promise. Instead
the plugin attaches the same warning through `tools/post-execute` `accept` with
`additionalContexts` (`dsh-tools/lib/index.js:3495-3518`) after a `bash` call
whose stderr contains `Name and email not configured` or `Email not
configured`. The command ran; the model is told its commits are unpushable.

Partial configuration is a distinct case and was measured:

```
$ JJ_CONFIG=/dev/null:<name-only>.toml jj commit -m t
Warning: Email not configured. Until configured, your commits will be created
with the empty identity, and can't be pushed to remotes.
```

Different wording, same outcome. The probe therefore requires **both**
`user.name` and `user.email`.

### A.6 Where each check runs, and what invalidates it

> **Corrected home.** This table says "once per session, lazily on first
> `jj`-workspace touch". [30](30-lifecycle-and-observability-surfaces.md) §1
> shows that is the wrong trigger and names the right one: **`agent/created`**,
> which is `@mode serial` and _awaited before session creation resolves_, with
> the loop holding queued input. `session/created` fires earlier but is a
> synchronous `emit` — async work there is not awaited and rejections are only
> logged. The workspace root is available at `agent/created` as
> `SessionHeader.cwd`, so no tool call is needed.
>
> The practical gain: the lazy trigger is really _once per session that touches
> `jj`_, and it puts 5–8 shell spawns on the **first** `jj` tool call — the one
> call where latency is most visible. Moving to `agent/created` behind a single
> `.jj` `ctx.fs.stat` gate makes a plain-Git or non-repo session cost exactly one
> stat.
>
> **And it is the second place `try/catch` is load-bearing.** A throw in an
> `agent/created` listener **fails session creation**, not one tool call — a
> larger blast radius than the guard's
> ([24](24-implementation-plan.md) §3.6). Wrap the whole preflight body.
>
> Three checks deliberately do **not** move: P6 identity stays re-probed on
> every commit-creating call; P12 conflicts stays per-call; P7 stays per-call
> for the guard, because the effective cwd comes from
> `exec.arguments.workdir`, which is unknowable at session start.

| #                | Runs at                                                          | Cache key          | Cached value                             | Invalidated by                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------- | ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1, P3, P5       | once per **session**, lazily on first `jj`-workspace touch       | session id         | resolved absolute paths, or `absent`     | a successful install; a `jjPath`/`jjHunkPath` config change; session end                                                                                                                                         |
| P2, P4           | once per **session**                                             | session id         | parsed version + capability-probe result | a successful install; session end                                                                                                                                                                                |
| P6               | once per session **and re-probed on every commit-creating call** | session id         | `configured` / `unconfigured`            | `jj config set` seen in a `bash` call; any commit-creating call (re-probe); session end                                                                                                                          |
| P7               | every **tool call**                                              | —                  | —                                        | n/a — it is a field read, not a probe                                                                                                                                                                            |
| P8, P9, P10, P13 | once per **workspace root**                                      | absolute root path | `{kind, repoDir, colocated, broken}`     | session start; `jj git init` / `jj workspace add` / `jj git colocation` / `jj git clone` observed in a `bash` call; any `rm`/`mv` in `bash` whose resolved path names `.git` or `.jj`; a `JJ_REPO_BROKEN` result |
| P11              | once per **workspace root**                                      | absolute root path | `string[]` of remotes                    | `jj git remote add\|remove\|rename` seen in `bash`; session start                                                                                                                                                |
| P12              | every **tool call** that mutates                                 | —                  | —                                        | always re-read; conflicts change on any operation and the probe is one cheap `jj log`                                                                                                                            |
| P14              | n/a                                                              | —                  | —                                        | n/a                                                                                                                                                                                                              |

Two rules the cache must obey:

1. **Nothing blocks plugin load.** P1–P13 are all lazy. A machine with no `jj`
   at all loads the plugin, and the plugin is inert
   ([19](19-jj-hunk-provisioning.md): "Detection must never block plugin load").
2. **A cache miss is not a failure.** Any probe that throws or returns an
   unexpected shape resolves to `unknown` and takes the **open** branch, never
   the closed one. Only a _positive_ observation ("`jj` is not on `PATH`",
   "`user.email` is empty") closes a door.

P6's re-probe on commit-creating calls is the one deliberate exception to
per-session caching: the call is rare (a handful per session), the probe costs
one `jj config list` (~10 ms), and a stale `configured` here reproduces exactly
the failure the check exists to prevent.

### A.7 Colocated vs native (P10) — does it change behaviour?

Yes, in three places, and only three.

| Difference       | Colocated (`.git` is a directory)                          | Native (`--no-colocate`)                      |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `jj git export`  | no-op — `No export needed in colocated workspaces.`        | exports refs to `.jj/repo/store/git`          |
| broken-repo risk | `.git` deletion is unrecoverable ([SPEC §5.7](../SPEC.md)) | no `.git` to delete; the same `rm` is a no-op |
| write protection | `.git/**` writes denied                                    | nothing to protect                            |

Everything else — detection, the guard, the verb map, the tool surface — is
identical. In particular, detection is **not** "`.git` absent means native":
`jj workspace add` produces a second workspace whose `.jj/` is a real directory
and whose `.git` is a **file** (`gitdir: ../<primary>/.git/worktrees/<name>`).
A detector that branches on `.git` must handle `directory` / `file` / `absent`.

`jj git export` measured in both:

```
$ (native)     jj git export   → (exports; exit 0)
$ (colocated)  jj git export   → No export needed in colocated workspaces.
```

### A.8 Remote (P11) and conflicts (P12)

**Remote.** `jj git remote list` prints `<name> <path>` per remote and exits 0;
with no remote it prints nothing and still exits 0 — so emptiness of stdout, not
the exit code, is the signal. Its only effect is the guidance the plugin gives:

```
$ jj git push --bookmark b1        # no remote configured
Warning: No matching remotes for names: origin
Error: No git remotes to push to
$ echo $?
1
```

When there is no remote, the plugin must not tell the model to `jj git push` —
it must say `jj git remote add origin <url>` first. This is the difference
between a useful hint and a hint that produces a second failure.

**Conflicts.** Two probes, both verified:

| Probe                                  | No conflicts                                                    | Conflicts present                              |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `jj resolve --list`                    | exit **2**, stderr `Error: No conflicts found at this revision` | exit **0**, stdout `f.txt    2-sided conflict` |
| `jj log --no-graph -T 'conflict' -r @` | `false`                                                         | `true`                                         |

The exit code is **inverted from the intuitive reading** — 2 means clean. The
template probe is preferred for the per-call check because it is a plain
true/false with no error path. `jj status` also warns (`Warning: There are
unresolved conflicts at these paths:`), but on stderr and only in some states.

---

## Part B — Error taxonomy

Codes are `SCREAMING_SNAKE_CASE`. The **channel** column says which seam carries
the error; §0 explains why that changes what the model sees.

> **Rule for the guard channel (B.2), verified by source trace:** the guard
> **returns `deny`, never throws, and never calls `exec.deferContext`.** A throw
> produces a `final-result` (`dsh-tools/lib/index.js:3267-3271`) that skips
> `postExecute` entirely (`:3126`); context deferred in a pre-execute listener is
> read only on the dispatch path (`:3333-3340`) and is **silently dropped** on a
> denial. Either mistake loses the guard's second channel — the explanation
> attached from `tools/post-execute`. Full trace and the two further constraints:
> [`SPEC.md` §5.2](../SPEC.md) and [31](31-probe-results-pipeline.md) Q1.

### B.1 Tool-channel errors

`{ error: { code, message, hint? } }` returned as the tool's value. `message` is
the literal string the model receives; `<…>` marks substitution.

| code                        | Trigger                                                                                                            | message                                                                                                                                                                                      | hint                                                                                                 | Posture                                                                          | Recovery                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NOT_JJ_WORKSPACE`          | any `jj_*` tool, no readable `.jj/` at the resolved root                                                           | `Not a Jujutsu workspace: <root> has no .jj directory. This tool never falls back to Git.`                                                                                                   | `Run \`jj git init\` to start a Jujutsu repo here, or use bash for non-jj work.`                     | **closed** (the tool cannot act)                                                 | `jj git init`                                                                                           |
| `JJ_MISSING`                | P1 fails                                                                                                           | `jj not found (looked for "<jjPath>" on PATH).`                                                                                                                                              | `Install Jujutsu, or set jjPath in the dsh-jujutsu config.`                                          | **closed** for tools · **open** for guard and `bash`                             | install `jj`, or set `jjPath`                                                                           |
| `JJ_VERSION_TOO_OLD`        | `jj --version` < 0.46.0 **and** a capability probe fails                                                           | `jj <found> is older than the supported floor 0.46.0; the required template features are missing.`                                                                                           | `Upgrade jj. The Git guard still works; only the jj_* tools are unavailable.`                        | **closed** for the failing tools · **open** if probes pass                       | upgrade `jj`                                                                                            |
| `JJ_HUNK_MISSING`           | P3 fails, on `jj_hunk_list` / `jj_hunk_apply`                                                                      | `jj-hunk not found (looked for "<jjHunkPath>" on PATH).`                                                                                                                                     | `cargo install --git https://github.com/laulauland/jj-hunk --rev <sha> jj-hunk`                      | **closed** for hunk tools · **open** elsewhere                                   | install `jj-hunk`                                                                                       |
| `JJ_HUNK_VERSION_TOO_OLD`   | P4 resolves a version < 0.5.1                                                                                      | `jj-hunk <found> predates 0.5.1: hunk ids use the older content/context hashes and --query is unavailable.`                                                                                  | `cargo install --git https://github.com/laulauland/jj-hunk --rev <sha> --force jj-hunk`              | **closed** for hunk tools                                                        | reinstall ≥ 0.5.1                                                                                       |
| `JJ_HUNK_INSTALL_DECLINED`  | user answered no, or `hunkInstall: 'never'`                                                                        | `jj-hunk is not installed and installation was declined for this session.`                                                                                                                   | `cargo install --git https://github.com/laulauland/jj-hunk --rev <sha> jj-hunk`                      | **closed** for hunk tools                                                        | install manually; a new session re-offers                                                               |
| `JJ_HUNK_INSTALL_FAILED`    | `cargo install` exits non-zero, or the post-install `--help` probe fails                                           | `Installing jj-hunk failed (cargo exit <n>). Last output: <tail of stderr>`                                                                                                                  | `Install manually, then set jjHunkPath to the binary.`                                               | **closed** for hunk tools, no retry                                              | manual install                                                                                          |
| `CARGO_MISSING`             | P5 fails at the moment of the offer                                                                                | `cargo not found; cannot install jj-hunk.`                                                                                                                                                   | `Install the Rust toolchain from https://rustup.rs, then re-run.`                                    | **open** (only the offer path is disabled)                                       | install rustup                                                                                          |
| `WORKSPACE_ROOT_UNRESOLVED` | `exec.agent?.session.header.cwd` is `undefined` or empty                                                           | `Cannot determine the workspace root for this session (exec.agent.session.header.cwd is unset).`                                                                                             | `Retry from a session that has a workspace.`                                                         | **open** for guard (`next()`) · **closed** for tools                             | none available                                                                                          |
| `JJ_IDENTITY_UNCONFIGURED`  | P6 fails on `jj_new` or `jj_hunk_apply(split\|commit\|squash)`                                                     | `jj user.name/user.email are not configured. Commits created now get the empty identity and jj refuses to push them ("Won't push commit <id> since it has no author and/or committer set").` | `jj config set --user user.name "Your Name" && jj config set --user user.email "you@example.com"`    | **closed** for commit-creating ops · **open** + warning elsewhere                | configure identity; repair existing commits with `jj metaedit --update-author -r 'author("") ~ root()'` |
| `JJ_REPO_BROKEN`            | `git_target` names a Git dir that does not exist                                                                   | `The jj repo at <root> is broken: it is colocated with a Git repo at <gitdir>, which is missing.`                                                                                            | `The operation log is unreadable, so \`jj op restore\` cannot help. Restore <gitdir> from a backup.` | **closed** for tools · **open** for guard                                        | restore `.git`; no in-band repair                                                                       |
| `JJ_REPO_UNREADABLE`        | `.jj/` exists but `stat`/`readText` throws (e.g. mode 000)                                                         | `The jj repo at <root> cannot be read: <path> is not accessible.`                                                                                                                            | `Check permissions on <root>/.jj.`                                                                   | **closed** for tools · **open** for guard                                        | fix permissions                                                                                         |
| `JJ_CONFLICTS_PRESENT`      | P12 returns `true` and the call would mutate a conflicted path                                                     | `The working copy has unresolved conflicts: <paths>. Mutating here operates on conflicted trees.`                                                                                            | `Inspect: jj resolve --list ; resolve: jj resolve <path> ; abandon: jj abandon @`                    | **open** with warning · **closed** only for `jj_hunk_apply` on a conflicted path | `jj resolve`                                                                                            |
| `REVSET_INVALID`            | `jj log -r <revset>` exits 1 with `Failed to parse revset`                                                         | `Invalid revset "<revset>": <first cause line>`                                                                                                                                              | `Check the syntax: jj help -k revsets`                                                               | **closed** for that call                                                         | fix the revset                                                                                          |
| `REVSET_NOT_SINGLE`         | plugin counts ≠ 1 revision for a `jj-hunk` call                                                                    | `The revset "<revset>" resolves to <n> revisions; jj-hunk needs exactly one.`                                                                                                                | `Narrow it, e.g. -r @ or -r <change-id>.`                                                            | **closed** for that call                                                         | narrow the revset                                                                                       |
| `HUNK_QUERY_EMPTY`          | pre-list with the same `--query` returns `{"files":[]}`                                                            | `The query "<query>" selects no hunks; nothing was applied.`                                                                                                                                 | `Run jj_hunk_list with the same query to see what is available, or widen it.`                        | **closed** for that call                                                         | widen the query                                                                                         |
| `HUNK_QUERY_INVALID`        | `jj-hunk` exits 1 with `Invalid hunkset query`                                                                     | `Invalid hunkset query "<query>": <cause>`                                                                                                                                                   | `Try a simpler form: added(content:"…"), changed(path:glob:"src/**").`                               | **closed** for that call                                                         | fix the query                                                                                           |
| `HUNK_SPEC_STALE`           | a `spec` object whose ids are not a subset of the immediately preceding `jj_hunk_list`                             | `The hunk spec is stale: <k> of <n> ids were not in the last jj_hunk_list. Hunk ids are SHA-256 over the materialized comparison and change on any edit.`                                    | `Re-run jj_hunk_list and rebuild the selection, or use --query.`                                     | **closed** for that call                                                         | re-list                                                                                                 |
| `HUNK_SPEC_INVALID`         | `spec` fails the plugin's own schema check                                                                         | `The hunk spec is not a valid selection: <violation>`                                                                                                                                        | `Expected {files:{<path>:{hunks:[<index>]}}, default:"reset"}.`                                      | **closed** for that call                                                         | fix the spec                                                                                            |
| `JJ_EXEC_FAILED`            | a `jj` command exits non-zero and matches no case above                                                            | `jj <args> failed (exit <n>): <first stderr line>`                                                                                                                                           | `Run \`jj <args>\` through bash to see the full output.`                                             | **closed** for that call                                                         | varies                                                                                                  |
| `SHELL_EXEC_FAILED`         | `ctx.shell.execute()` rejects (infrastructure failure — the spawn produced no process), or spec preparation throws | `Failed to run <command>: <error.message>`                                                                                                                                                   | _(none — environment failure, not a usage error)_                                                    | **closed** for the tool that needed it · guard still returns `next()`            | retry; inspect the executor                                                                             |
| `SHELL_TIMEOUT`             | `ShellRunResult.timedOut === true`                                                                                 | `\`<command>\` exceeded the <timeoutMs> ms deadline and was killed.`                                                                                                                         | `Narrow the revset or paths, or raise timeoutMs (cap 600000 ms).`                                    | **closed** for that call                                                         | narrow, or raise the deadline                                                                           |
| `FS_ERROR`                  | `ctx.fs.stat` / `readText` throws or returns an unexpected shape while probing                                     | `Filesystem error while probing <path>: <error.message>`                                                                                                                                     | _(none)_                                                                                             | **open** for guard (`next()`) · **closed** for tools                             | fix the underlying permission or path                                                                   |

Three of these codes exist **only because `jj-hunk` does not report the
condition itself**. Each was measured; each is a case where the naive
implementation would return success:

| code                       | What `jj-hunk` actually does                                                     | Measured                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUNK_QUERY_EMPTY`         | exits **0** and prints `{"files": []}`                                           | `jj-hunk list --query 'added(content:"ZZZ_NOPE")'` → exit 0                                                                                                                       |
| `HUNK_QUERY_EMPTY` (apply) | exits **0**, no-op, no message                                                   | `jj-hunk split --query 'added(content:"ZZZ_NOPE")' "msg"` → exit 0, log unchanged                                                                                                 |
| `HUNK_SPEC_STALE`          | exits **0**, creates an **empty commit**, leaves the changes in the working copy | `jj-hunk split --spec-file <stale>` → `Warning: No changes have been selected, so the new revision will be empty.` + `Selected changes : <id> (empty) stale with changes`, exit 0 |
| `REVSET_NOT_SINGLE`        | exits **0**, silently diffs the merged revision set                              | `jj-hunk list -r 'all()'` and `-r '@\|@-'` → exit 0, JSON hunks                                                                                                                   |

The stale-spec case is the worst of the three: the user asked to split out a
change and got an empty commit with their message on it and all their changes
still uncommitted. **`HUNK_SPEC_STALE` cannot be detected from `jj-hunk`'s exit
code or output** — it must be caught by comparing ids against the plugin's own
last list. This is the concrete enforcement of
[18](18-tool-surface.md) rule 2 ("`jj_hunk_apply` should reject a query that
selects nothing rather than reporting a silent success") and rule 1 ("IDs are
not accepted across calls").

`REVSET_NOT_SINGLE` likewise has to be enforced by the plugin, with its own
count:

```
jj log --no-graph -T 'change_id' -r '<revset>'   # must be exactly 1 line
```

Passing a multi-rev revset straight through to `jj-hunk` produces no error at
all. `jj-hunk list -r A -r B` (two flags) _is_ rejected, by clap, with exit 2 —
which is a different mistake and not the one that matters.

### B.2 Guard-channel denials

These are `{kind:'deny', reason}` and the model sees only `Error: <reason>`. The
code is carried in `info.code` for durable diagnostics and **is not visible to
the model**, so `reason` must be self-contained and must name the `jj`
replacement command. Full text and the verb table: [15](15-verb-mapping.md),
[17](17-bypass-and-approval.md), [21](21-guard-evasion.md).

| code (`info.code`)         | Trigger                                                                          | Posture                                                     |
| -------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GUARD_GIT_DENIED`         | a resolved program basename of exactly `git` inside a `jj` workspace             | **closed** (deny) by default, `ask` under the bypass policy |
| `GUARD_JJ_INTERNALS_WRITE` | `read`/`write`/`edit` targeting `.jj/**` or `.git/**`                            | reads **open**, writes **closed**                           |
| `GUARD_REPO_STORE_DELETE`  | destructive verb whose resolved path names the exact component `.git` or `.jj`   | `ask` when a human is present, `deny` under `never`         |
| `GUARD_JJ_NO_WORKSPACE`    | a `jj` command that needs a workspace, in a directory with none, under `forceJj` | **closed**, always — no bypass applies                      |

`GUARD_JJ_NO_WORKSPACE` is the one refusal that fires _before_ the command would
have failed: without a workspace, most `jj` subcommands exit with
`There is no jj repo in "."`, which tells the model nothing it can act on. The
reason names `jj git init --colocate` instead. It is in the same family as the
Git refusal — a redirection, not a permission — but it is **not** answerable by
the bypass: `bypass: allow` means "run this Git command anyway", and there is no
command here to run. Commands that do not need a workspace are never refused
(`jj git init`, `jj git clone`, `jj config`, `jj help`, `jj util`, `jj version`,
`--version`, bare `jj`, every `-R <path>`), and where adoption was already
refused the code stays `GUARD_JJ_NO_WORKSPACE` but the copy says "use Git
here instead" — naming an init the probe would reject would be a dead end. See
[§5.15](../SPEC.md) and [37](37-git-compatible-adoption.md).

**The guard must never produce any other error.** Every internal failure inside
the listener — a throwing detector, an unreadable `.jj`, an unresolved root —
must be caught and turned into `next()`. This is not stylistic:
`tools/pre-execute` runs inside a `try` block in
`dsh-tools/lib/index.js:3221-3225`, and a throw there is converted into a tool
error result (`toolErrorResult(error)`, `:3198`). A detector bug would therefore
turn **every `bash` call in the session into a failure** — the precise opposite
of "fail open". The listener body is one `try { … } catch { return next(); }`.

### B.3 Post-execute advisory (not an error)

| code (`info.code`)          | Trigger                                                                                       | Effect                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `JJ_IDENTITY_EMPTY_COMMITS` | a `bash` call whose stderr contains `Name and email not configured` or `Email not configured` | `{kind:'accept', additionalContexts:[…]}` — the command stands, and the model is told once per session that its commits cannot be pushed |

The command is **not** blocked and **not** turned into an error. `block` would
be wrong here: the shell call succeeded, and re-running it after the fix would
be the model's job, not the harness's.

---

## Part C — The fail-open / fail-closed rule

[SPEC §8](../SPEC.md) states the principle as **"fail open, deny narrowly"**,
and the reason is sound: _"The guard's job is to catch the habitual Git command,
not to be a security boundary."_ But a slogan applied uniformly produces two
wrong answers, so the principle needs to be stated more precisely.

### C.1 The rule

> **Fail open on anything that only limits what the plugin itself can do. Fail
> closed on anything that would let the user create a durable artifact they
> cannot easily undo, or that would consume a resource which cannot be
> interrupted.**

The discriminator is not severity, and it is not whether the operation is
"dangerous". It is **who pays for the mistake**:

- A wrong _open_ costs a confusing error message the model can recover from in
  one step, because every message names the next command.
- A wrong _closed_ blocks work that had no correct alternative anyway.
- A wrong _open on a durable artifact_ costs a repair the user has to discover —
  and, in the identity case, a repair that is invisible until push time.

That yields three rules, in priority order:

**R1 — Never block the shell.** Any failure inside the guard listener resolves
to `next()`. A broken detector must not stop `pnpm build`. Corollary: the guard
denies on _classification_ only, never on _environment_ — it does not need `jj`,
`jj-hunk`, `cargo`, an identity, or a resolvable version to do its job.

**R2 — Never silently degrade to something worse.** When a capability is
missing, the operation that needs it fails with the install command; it does not
fall back to a substitute that behaves differently. `jj-hunk` absent must not
become `jj split -i` ([19](19-jj-hunk-provisioning.md): it needs a TTY and a
headless agent driving it will _hang_, not fail). `json(self)` unavailable must
not become graph-text scraping.

**R3 — Never let an avoidable, permanent artifact be created silently.** An
operation that mints history with the empty identity, or that would write into
`.jj/`, is refused — not warned about.

### C.2 The two tensions, resolved

| Tension                                   | Naive reading                   | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "fail open" vs. missing `jj-hunk`         | hunk tools degrade to something | **Closed.** The hunk tools refuse with `JJ_HUNK_MISSING` and the `cargo install` line. Everything else — guard, reads, `bash` — is untouched, so the _plugin_ fails open even though the _operation_ fails closed. The distinction between the two is what the slogan is actually about.                                                                                                                                                                                     |
| "deny narrowly" vs. unconfigured identity | warn and let the model decide   | **Closed for commit-creating operations.** A warning is the right shape only when the model can act on it before the damage. Here the damage is done by the very call that produces the warning, is invisible until push, and persists after the config is fixed. Denying `jj_new` costs one prompt; allowing it costs a repair. The posture is narrow because it applies to exactly three call shapes, and it is a _precondition check_, not a policy on the user's intent. |

Two further boundary cases, decided the same way:

| Case                                                   | Posture                                      | Why                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard denies on a `bash` call while the repo is broken | **open**                                     | The repo being broken is not a reason to block the shell — the user may be about to fix it. The guard's classification does not need a working repo.           |
| `jj_hunk_apply` when the working copy is conflicted    | **closed for conflicted paths only**         | Reads and non-conflicted paths proceed with a warning. Applying a hunk selection to a conflicted tree is the one case where the result is genuinely ambiguous. |
| Installing `jj-hunk`                                   | **closed by default** (`hunkInstall: 'ask'`) | It is a system mutation with a supply-chain surface, not a config toggle ([19](19-jj-hunk-provisioning.md)). `auto` exists and is not the default.             |

### C.3 The decision table

| Failure class                      | Shell | Guard | Reads          | Mutations                      | Commit-creating            |
| ---------------------------------- | ----- | ----- | -------------- | ------------------------------ | -------------------------- |
| detection error / unreadable `.jj` | open  | open  | closed         | closed                         | closed                     |
| root unresolvable                  | open  | open  | closed         | closed                         | closed                     |
| `jj` missing / too old             | open  | open  | closed         | closed                         | closed                     |
| repo broken                        | open  | open  | closed         | closed                         | closed                     |
| conflicts present                  | open  | open  | open           | open + warning                 | closed on conflicted paths |
| `jj-hunk` missing / old / declined | open  | open  | open           | closed (hunk only)             | closed (hunk only)         |
| identity unconfigured              | open  | open  | open + warning | open + warning                 | **closed**                 |
| remote absent                      | open  | open  | open           | open                           | open (guidance changes)    |
| command text unparseable           | open  | open  | open           | open                           | open                       |
| `jj-hunk` exits 0 but did nothing  | —     | —     | —              | **closed** (plugin pre-checks) | **closed**                 |

The last row is the one that is easy to miss: it is not an environment problem
at all, it is a _silent success_, and the plugin's own pre-check is the only
thing standing between the model and an empty commit.

---

## Part D — What was measured vs what is proposed

### D.1 Verification table

| #   | Claim                                                                                          | Command that proved it                                                                                                               | Status                |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 1   | `jj` 0.46.0 at `/opt/homebrew/bin/jj`                                                          | `command -v jj` · `jj --version` → `jj 0.46.0`                                                                                       | **VERIFIED**          |
| 2   | `jj --version` output is exactly `jj <semver>\n`                                               | `python3 -c "print(repr(...))"` → `'jj 0.46.0\n'`                                                                                    | **VERIFIED**          |
| 3   | a missing command exits 127 with `command not found`                                           | `bash -c 'jj-does-not-exist --version'` → exit 127                                                                                   | **VERIFIED**          |
| 4   | `command -v` exits 1 for an absent binary, 0 for a present one                                 | `bash -c 'command -v jj-does-not-exist'` → 1; `command -v jj` → 0                                                                    | **VERIFIED**          |
| 5   | `jj-hunk` 0.5.1 at `~/.cargo/bin/jj-hunk`                                                      | `command -v jj-hunk`                                                                                                                 | **VERIFIED**          |
| 6   | `jj-hunk` has no version surface                                                               | `jj-hunk --version` / `-V` / `version` all error; `strings … \| grep -c '0\.5\.1'` → 0                                               | **VERIFIED**          |
| 7   | `cargo install --list` reports `jj-hunk v0.5.1`                                                | `cargo install --list`                                                                                                               | **VERIFIED**          |
| 8   | `cargo` 1.99.0 present                                                                         | `cargo --version`                                                                                                                    | **VERIFIED**          |
| 9   | `cargo-binstall` is absent                                                                     | `command -v cargo-binstall` → absent                                                                                                 | **VERIFIED**          |
| 10  | unconfigured identity: warning on **stderr**, exit **0**                                       | `jj commit -m … 2>/dev/null` → empty stdout; `1>/dev/null` → warning                                                                 | **VERIFIED**          |
| 11  | the commit gets an empty identity                                                              | `jj log --no-graph -T 'author.email()' -r @-` → `""`                                                                                 | **VERIFIED**          |
| 12  | `jj` refuses to push an empty-identity commit                                                  | local bare remote + `jj git push --bookmark main` → `Error: Won't push commit … since it has no author and/or committer set`, exit 1 | **VERIFIED**          |
| 13  | configuring later does not repair existing commits                                             | same push after setting `user.name`/`user.email` → same error                                                                        | **VERIFIED**          |
| 14  | `jj metaedit --update-author` repairs them                                                     | `jj metaedit --update-author -r main` then push → succeeds, remote received the commit                                               | **VERIFIED**          |
| 15  | `author("")` selects the empty-identity commits                                                | `jj log --no-graph -T 'description.first_line()' -r 'author("")'` → `two one`                                                        | **VERIFIED**          |
| 16  | partial identity warns with different text                                                     | name-only config → `Warning: Email not configured.`                                                                                  | **VERIFIED**          |
| 17  | `JJ_USER`/`JJ_EMAIL` satisfy the identity                                                      | `JJ_USER=… JJ_EMAIL=… jj commit` → no warning; author populated                                                                      | **VERIFIED**          |
| 17a | `jj new` mints an empty identity                                                               | `jj new -m fresh` (no config) → author email `""`                                                                                    | **VERIFIED**          |
| 17b | `jj describe` preserves the existing author                                                    | `jj describe -m described` after a real-identity commit → still `real@example.com`                                                   | **VERIFIED**          |
| 17c | `jj squash` preserves the destination's author                                                 | `jj squash` (no config) → destination author unchanged, no warning emitted                                                           | **VERIFIED**          |
| 17d | `jj-hunk split`, `commit` **and** `squash` each mint an empty identity                         | each run with `JJ_CONFIG=/dev/null` → warning emitted, resulting author `""`                                                         | **VERIFIED**          |
| 18  | `jj config list user` is a clean two-key probe, exit 0 either way                              | set → `user.name = …` / `user.email = …`; unset → empty, exit 0                                                                      | **VERIFIED**          |
| 19  | `jj config list <a> <b>` is rejected — only one name allowed                                   | `jj config list user.name user.email` → `error: unexpected argument 'user.email' found`, exit 2                                      | **VERIFIED**          |
| 20  | `jj status` in a `.git`-deleted colocated repo: exit 255, stdout empty                         | `jj status 2>/dev/null` empty; stderr `Internal error: The repository appears broken or inaccessible`                                | **VERIFIED**          |
| 21  | every `jj` read fails identically in that state                                                | `jj log` / `jj op log` / `jj diff --summary` / `jj bookmark list` → all exit 255                                                     | **VERIFIED**          |
| 22  | the broken repo cannot be re-initialised in place                                              | `jj git init --colocate` → `Error: The target repo already exists`                                                                   | **VERIFIED**          |
| 23  | an unreadable `.jj` fails with a **different** message, same exit 255                          | `chmod 000 .jj` → `Internal error: Failed to determine the secure config for a repo`                                                 | **VERIFIED**          |
| 24  | `git_target` distinguishes colocated (`../../../.git`) from native (`git`)                     | `cat .jj/repo/store/git_target` in both fixtures                                                                                     | **VERIFIED**          |
| 25  | `git_target` still names the missing `.git` after deletion                                     | same `cat` in the broken fixture → `../../../.git`                                                                                   | **VERIFIED**          |
| 26  | the filesystem-only broken check works on all five fixtures                                    | a 5-fixture script resolving `.jj/repo` → `git_target` → `stat`                                                                      | **VERIFIED**          |
| 27  | a secondary workspace's `.jj/repo` is a **file** holding the real repo path                    | `cat <ws2>/.jj/repo` → `../../<primary>/.jj/repo`                                                                                    | **VERIFIED**          |
| 28  | a secondary workspace's `.git` is a **file**                                                   | `cat <ws2>/.git` → `gitdir: ../<primary>/.git/worktrees/<ws2>`                                                                       | **VERIFIED**          |
| 29  | `jj workspace root` resolves the root; exits 1 outside a repo                                  | `jj workspace root` → path, exit 0; outside → `Error: There is no jj repo in "."`, exit 1                                            | **VERIFIED**          |
| 30  | `jj git export` is a no-op when colocated, real when native                                    | colocated → `No export needed in colocated workspaces.`; native → exports the ref                                                    | **VERIFIED**          |
| 31  | `jj git remote list` is empty with exit 0 when there is no remote                              | `jj git remote list; echo $?` → exit 0, no output                                                                                    | **VERIFIED**          |
| 32  | `jj git push` with no remote fails with a specific message                                     | → `Error: No git remotes to push to`, exit 1                                                                                         | **VERIFIED**          |
| 33  | `jj resolve --list` exits **2** with no conflicts and **0** with them                          | clean → exit 2, `Error: No conflicts found at this revision`; conflicted → exit 0, `f.txt    2-sided conflict`                       | **VERIFIED**          |
| 34  | `-T 'conflict' -r @` is a boolean conflict probe                                               | conflicted → `true`; clean → `false`                                                                                                 | **VERIFIED**          |
| 35  | an invalid revset is a parse error, exit 1                                                     | `jj log -r 'nonexistent@@@'` → `Error: Failed to parse revset: Syntax error`, exit 1                                                 | **VERIFIED**          |
| 36  | `jj-hunk` **silently accepts** a multi-revision revset                                         | `jj-hunk list -r 'all()'` and `-r '@\|@-'` → exit 0, JSON hunks                                                                      | **VERIFIED**          |
| 37  | `jj-hunk` rejects a repeated `-r` flag (clap, exit 2)                                          | `jj-hunk list -r @ -r @-` → `error: the argument '--rev <REV>' cannot be used multiple times`                                        | **VERIFIED**          |
| 38  | an empty hunkset query exits **0** with `{"files": []}`                                        | `jj-hunk list --query 'added(content:"ZZZ_NOPE")'`                                                                                   | **VERIFIED**          |
| 39  | an empty query on **apply** is a silent no-op, exit 0                                          | `jj-hunk split --query '…NOPE…' "msg"` → exit 0, log unchanged                                                                       | **VERIFIED**          |
| 40  | an invalid hunkset query is exit 1 with a cause                                                | `jj-hunk list --query 'added(content:'` → `Error: Invalid hunkset query`                                                             | **VERIFIED**          |
| 41  | a **stale spec** exits 0 and creates an **empty commit**                                       | `jj-hunk split --spec-file <pre-edit spec>` → `Warning: No changes have been selected, so the new revision will be empty.`, exit 0   | **VERIFIED**          |
| 42  | hunk ids regenerate on any edit                                                                | pre/post `// touch` id comparison → changed                                                                                          | **VERIFIED**          |
| 43  | `jj-hunk` outside a repo is exit 1 with a specific message                                     | `jj-hunk list` in a non-repo → `Error: jj diff failed: Error: There is no jj repo in "."`                                            | **VERIFIED**          |
| 44  | a guard `deny` reaches the model as exactly `Error: <reason>`                                  | `dsh-tools/lib/index.js:3241-3256`                                                                                                   | **VERIFIED** (source) |
| 45  | `ToolErrorInfo` is `{name, code, reason?}`                                                     | `dsh-tools/lib/types/index.d.ts:378`                                                                                                 | **VERIFIED** (source) |
| 46  | a throwing `pre-execute` listener becomes a tool error, not a pass-through                     | `dsh-tools/lib/index.js:3221-3225` inside `try`, `:3198` `toolErrorResult`                                                           | **VERIFIED** (source) |
| 47  | `ShellRunResult` carries `timedOut` / `aborted` / `sandbox`                                    | `dsh-shell/lib/types/types.d.ts`                                                                                                     | **VERIFIED** (source) |
| 48  | `ShellExecRequest` accepts `timeoutMs`, `onExpiry`, `signal`                                   | same file                                                                                                                            | **VERIFIED** (source) |
| 49  | `ctx.shell.execute()` rejects only for infrastructure failures                                 | `dsh-shell/lib/types/index.d.ts`                                                                                                     | **VERIFIED** (source) |
| 50  | `ctx.fs.stat(target)` returns `FsInfo \| undefined`, with `type: 'file'\|'directory'\|'other'` | `dsh-fs/lib/types/index.d.ts:138`, `types.d.ts:67-74`                                                                                | **VERIFIED** (source) |
| 51  | `exec.agent?.session.header.cwd` is the workspace-root accessor                                | used verbatim in `dsh-tool-skill/lib/index.js:141,175,208`                                                                           | **VERIFIED** (source) |
| 52  | `tools/post-execute` `accept` can attach `additionalContexts`                                  | `dsh-tools/lib/types/index.d.ts:465`; shipping use in `dsh-hooks-claude-code/lib/index.js:265`                                       | **VERIFIED** (source) |
| 53  | the bash executor defaults to 120 s and caps at 600 s                                          | `dsh-bash-local/lib/index.js:71-72`                                                                                                  | **VERIFIED** (source) |
| 54  | no user config was written by any probe                                                        | `~/.config/jj/repos/` does not exist after all runs                                                                                  | **VERIFIED**          |

All `jj` runs used `JJ_CONFIG=/dev/null`, or
`JJ_CONFIG="/dev/null:<scratch>.toml"` where identity was needed. No
`jj config set --repo` was run. Scratch repos lived under `/tmp` and were
removed; the pre-existing `/tmp/jjverify*` and `/tmp/jjnocol` fixtures from
[13](13-empirical-verification.md) were left in place.

### D.2 UNVERIFIED — do not build on these without testing first

| Claim                                                                                            | Why it is unverified                                                                     | What would settle it                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| behaviour of `jj` **< 0.46.0**                                                                   | no older binary installed; none was fetched                                              | install 0.45.x in a container and run the capability probes  |
| behaviour of `jj-hunk` **< 0.5.1**, and whether the 64-hex id shape actually discriminates 0.5.0 | no older binary; the crate version is not recoverable from the binary                    | build 0.5.0 from source and compare `list --format json` ids |
| `.jj/repo/store/git_target` exists with this layout in other `jj` versions                       | internal layout detail, read from one version only                                       | run the 5-fixture script against 0.44 / 0.45 / 0.47          |
| the pinned install form `cargo install --git … --rev <sha>`                                      | not run; only the unpinned form was measured (37.25 s, [19](19-jj-hunk-provisioning.md)) | run it once with a real sha                                  |
| `cargo binstall --git …`                                                                         | `cargo-binstall` absent                                                                  | install it and time the run                                  |
| a push to a **network** remote (GitHub, SSH auth, `--allow-new`)                                 | only a local bare repo was used                                                          | configure a real remote                                      |
| `sandbox.denied` / `runnerFailed` interaction with the probes                                    | no sandboxed executor was exercised from a plugin context                                | mount `dsh-bash-sandbox` and force a denial                  |
| the plugin's own `ctx.shell` calls behave exactly like this session's `bash` tool                | every command here ran through the session's `bash`, not through a plugin's `ctx.shell`  | write the preflight module and run it                        |
| Windows behaviour of every check (PATH, `.cargo/bin`, permission bits)                           | not on Windows                                                                           | CI matrix                                                    |
| whether `jj config list user` warns on stderr in every unset combination                         | only the `user.email`-alone case was captured                                            | broaden the probe matrix                                     |

### D.3 Claims inherited from other documents, not re-measured here

| Claim                                                                      | Source                                | Status as used                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `.jj` is a directory in both primary and secondary workspaces              | [13 §2](13-empirical-verification.md) | relied on for P8; re-observed incidentally                                           |
| `rm -rf .git` is unrecoverable in a colocated repo and a no-op when native | [SPEC §5.7](../SPEC.md)               | relied on for P9's message; the broken state itself was re-measured (rows 20-23)     |
| `jj-hunk` install takes ~37 s and lands in `~/.cargo/bin`                  | [19](19-jj-hunk-provisioning.md)      | relied on for the offer's wording; not re-run                                        |
| hunk ids are SHA-256 over the materialized comparison                      | [13 §6](13-empirical-verification.md) | relied on for `HUNK_SPEC_STALE`'s message; the regeneration was re-measured (row 42) |

### D.4 Checks whose correct posture could not be decided

Recorded honestly rather than guessed:

1. **`JJ_HUNK_VERSION_TOO_OLD` when the version cannot be read at all.** §A.4
   proposes _warn and proceed_, on the argument that the 0.5.1 ID contract is
   self-detecting because ids never cross turns. The counter-argument is that
   `--query` and `--spec-template` are _not_ self-detecting, and an older binary
   may lack them. The plugin could probe those two capabilities directly and
   refuse on their absence — which would make the version check unnecessary —
   but which older `jj-hunk` releases have them is **UNVERIFIED**, so the
   capability set cannot yet be pinned to a version. This should be settled by
   building 0.5.0 before the check is finalized.
2. **`JJ_CONFLICTS_PRESENT` on `jj_new`.** This document refuses only
   `jj_hunk_apply` on a conflicted path and warns elsewhere. `jj_new` on a
   conflicted working copy is arguably the same hazard — it leaves the conflict
   behind on a parent and the model may not notice — but `jj new` is also the
   documented way to _escape_ a conflicted state, so refusing it would remove
   the recovery path. Leaning: keep it open with a warning. Not settled.
3. **Whether P6 should be re-probed on `bash` calls that create commits.** The
   post-execute advisory (§A.5) tells the model after the fact. Blocking the
   `bash` call would violate R1, but attaching the warning _before_ the call
   (via the guard's `ask`, which shows a reason) is possible and was not
   evaluated against [17](17-bypass-and-approval.md)'s approval semantics.
