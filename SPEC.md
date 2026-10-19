# `dsh-jujutsu` — specification

**Status:** draft for review. Nothing here is implemented.
**Runtime targeted:** DSH `0.2.0-rc.2`, Cordis `4.0.4`, Node ≥ 24.
**Toolchain:** `jj` 0.46.0, `jj-hunk` 0.5.1.

Every harness claim in this document is backed by
[11](docs/11-verified-dsh-api-contract.md) (read from the installed source) or
[13](docs/13-empirical-verification.md) (measured on this machine). Where a
claim is neither, it is marked **UNVERIFIED** and must be settled before it
becomes a dependency.

---

## 1. Problem

An agent working in a Jujutsu repository emits Git commands. It does so because
Git is what it was trained on, and because in a colocated `jj` workspace Git
**appears to work**:

```
$ git commit -m "via git"
[detached HEAD 3c02384] via git
$ jj log
Reset the working copy parent to the new Git HEAD.
```

The commit succeeds. The repository is now in detached HEAD and `jj` has
silently rewritten the relationship between the working copy `@` and its
parent. Every subsequent assumption the agent makes about "the current branch"
is wrong. ([13 §4](docs/13-empirical-verification.md))

Meanwhile the harness has no idea any of this is happening: there is no `git`
tool to disable, and nothing in DSH knows what `jj` is.

## 2. Scope

**In scope**

1. **Detect** a Jujutsu workspace, at the granularity of one tool call.
2. **Refuse** Git-shaped operations inside it, with a denial that names the
   exact `jj` command to run instead.
3. **Bridge `jj-hunk`** so an agent can split, commit, and squash specific
   hunks non-interactively.
4. **Explain** Jujutsu to the model: the working-copy model, change IDs,
   bookmarks, and the operation log, so it does not need to be told twice.

**Non-goals**

- Replacing or wrapping the `bash` tool. `jj` is driven through `bash`.
- Reimplementing `jj` or `jj-hunk` in TypeScript. Both are external binaries.
- Managing `jj` configuration on the user's behalf. Detect and advise; do not
  rewrite `~/.config/jj/config.toml`.
- Any UI beyond the plugin's own settings panel. The panel configures this
  plugin; it does not surface repository state.
- Enforcing anything outside a `jj` workspace. By default the plugin must be
  **invisible** everywhere else; the one exception is the explicit `forceJj`
  opt-in (§5.15), which exists precisely because a user can decide that the
  invisibility is the problem.

## 3. Package shape

Modelled on the conventions proven by `dsh-tinyfish`
(see [16](docs/16-package-conventions.md)) for the _manifest_, and on
`dsh-fs-observation-policy` for the _plugin kind_.

**The plugin kind matters more.** The harness ships a family of **policy
plugins** — `dsh-fs-observation-policy`, `dsh-sandbox-policy`,
`dsh-session-checkpoint-policy`, `dsh-tool-call-timeout-policy`,
`dsh-spill-policy`, `dsh-permission-presets` — and `dsh-jujutsu` is one of them:
it owns no service, registers no capability, and exists only to constrain and
inform the ones that do. `dsh-fs-observation-policy` describes the shape
exactly:

> Event-only … policy; **it registers no service**. A weak owner/target map
> records every authoritative observation, single-slot intent listeners derive
> guards from that state, and the provider performs the atomic check. Without
> this plugin, tools retain the bare provider's unconditional behavior.

So: listeners on existing waterfalls, plugin-local state, and decisions the
provider enforces. No new service and no new capability; the only client-side
contribution is the plugin's own configuration panel. The full
extension map and the seams this leaves on the table are in
[27](docs/27-integration-surfaces.md).

```
dsh-jujutsu/
├── package.json          # name dsh-jujutsu; dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # insert the plugin row
├── src/
│   ├── index.ts          # plugin entry: name, inject, Config, apply()
│   ├── detect.ts         # workspace detection
│   ├── guard.ts          # tools/pre-execute listener
│   ├── verbs.ts          # Git → jj mapping table
│   ├── hunk.ts           # jj-hunk bridge
│   └── shell.ts          # thin ctx.shell wrapper for running jj/jj-hunk
├── test/
├── docs/
└── README.md
```

`package.json` essentials:

```jsonc
{
  "name": "dsh-jujutsu",
  "type": "module",
  "main": "lib/index.mjs",
  "types": "lib/index.d.mts",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" },
}
```

The plugin's exported `name` is `dsh-jujutsu`; the bundle row name must equal
the **installed package name**, not the exported one (the
`dsh-opencode-patch` failure mode documented in `dsh-tinyfish/docs/dsh-contracts.md`).

`dsh.client` declares the admin panel, and `exports["./client"]` points at
`lib/client.js` — built by `vp pack` from `src/client/panel.ts`, with the
`window.__ModuleLoader__.load` wrapper as the bundler's `banner`/`footer`. The
harness's route serves `${package}/client.js` and accepts only `/^client\..*\.js$/`,
so `scripts/name-client-bundle.ts` renames the emitted `client.cjs`.
The host half _is_ built: `main` is `lib/index.js`, because Node refuses to strip
types for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
so shipping `src/index.ts` as the entry yields a package that cannot load once installed.

## 4. Architecture

```
                    ┌──────────────────────────────────────────┐
   bash tool call → │ tools/pre-execute waterfall              │
                    │                                          │
                    │  1. detect(exec) ──▶ not a jj workspace? │──▶ next()  (invisible)
                    │         │                                │
                    │         ▼ is a jj workspace              │
                    │  2. classify(exec.arguments.command)     │
                    │         │                                │
                    │         ├─ git-shaped ──▶ {kind:'deny',   │
                    │         │                  reason: <jj>} │
                    │         ├─ jj-shaped  ──▶ next()          │
                    │         └─ other      ──▶ next()          │
                    └──────────────────────────────────────────┘
```

Plus, off the hot path:

```
   per-assembly     → context injection: how to drive jj (rule + state; manual via skill)
   jj-hunk bridge   → tool calls that shell out to jj-hunk and return JSON
```

### Why `tools/pre-execute` and not `tools.guard`

`pre-execute` is the extensible waterfall and can consult async state (the
filesystem, for detection). `tools.guard` is synchronous and monotonic — the
right tool for an invariant that must not be overridable, but detection needs
I/O. So: **async policy in `pre-execute`**. If the project later needs the
invariant to be un-overridable by other plugins, add a synchronous
`tools.guard` that re-checks a cached detection result.

## 5. Components

### 5.1 Detection (`detect.ts`)

```
detect(exec) -> { kind: 'jj' | 'jj-colocated' | 'none', root: string }
```

Signals, in order ([13 §1](docs/13-empirical-verification.md)):

| Check                                | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `.jj/` is a directory                | a Jujutsu workspace — **the** signal                      |
| `.git/` is a directory, also present | colocated (the `jj git init` default)                     |
| `.git` is a file                     | secondary `jj workspace add` workspace, or a Git worktree |
| neither                              | not ours → `next()`                                       |

The workspace root comes from the **execution's session**, not `process.cwd()`.
The canonical accessor, taken from how the filesystem tools themselves resolve
paths (`dsh-tool-fs/lib/index.js`, `lib/types/session-cwd`):

```ts
const root = exec.agent?.session.header.cwd; // undefined for a non-agent caller
```

Its own doc comment states the rule and the trap:

> the agent's per-session workspace (`exec.agent.session.header.cwd`), so each
> session's `read`/`write`/`edit` act on its workspace, not the server's launch
> directory. […] `process.cwd()` at the tool boundary.

**VERIFIED.** So: `undefined` → fail open (`next()`), because a non-agent caller
has no workspace to reason about.

**But the session cwd is not necessarily the command's cwd.** The `bash` tool
exposes a `workdir` parameter, and its own description tells the model to
_"pass `workdir` instead of using `cd`"_. The tool resolves it with
(`dsh-tool-bash/lib/index.js:293`, quoted verbatim):

```js
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
  const headerCwd = exec.agent?.session.header.cwd;
  const sessionCwd = policyWorkspaceRoot ?? headerCwd;
  if (modelWorkdir === void 0) return sessionCwd;
  if (sessionCwd !== void 0 && !isAbsolute(modelWorkdir))
    return `${sessionCwd}${sep}${modelWorkdir}`;
  return modelWorkdir;
}
```

Three things follow:

1. **A resolved sandbox-policy root wins over the session cwd.** The comment says
   why: _"so workdir and confinement use the exact same per-call identity."_
2. A relative `workdir` is joined by **string concatenation**, not
   `path.resolve` — no `..` normalisation. For directory identity the two agree,
   but the guard should normalise.
3. The guard must mirror this, not use the raw session cwd:

```ts
const sessionCwd = exec.agent?.session.header.cwd; // + policy root when available
const cwd =
  exec.arguments.workdir === undefined
    ? sessionCwd
    : isAbsolute(exec.arguments.workdir)
      ? exec.arguments.workdir
      : resolve(sessionCwd ?? "", exec.arguments.workdir);
```

Skipping this is wrong in both directions: a `git` command run with
`workdir: '../other'` inside another `jj` repo would slip through, and a Git
command in a non-`jj` sibling would be refused because the _session_ root is a
`jj` repo.

**OPEN:** whether the guard can obtain the same `policyWorkspaceRoot` the tool
computes. If it cannot, it accepts a divergence only when the two disagree, and
that divergence must be logged rather than silently taken.

Cache per effective root; invalidate on any `jj git init` / `jj workspace add`
observed in a `bash` call, and on session start.

### 5.2 Guard (`guard.ts`)

```ts
ctx.on("tools/pre-execute", async (exec, next) => {
  if (exec.name !== "bash") return next();
  const detection = await detect(exec);
  if (detection.kind === "none") return next();
  const verdict = classify(commandOf(exec), detection);
  if (verdict.kind === "deny") return { kind: "deny", reason: verdict.reason };
  return next();
});
```

- `commandOf(exec)` reads `exec.arguments.command` — the bash tool's schema is
  `{ command, description, timeoutMs? }`.
- `classify` resolves the **invoked program**, it does not scan for the `git`
  token: split on shell operators, strip `VAR=value` and wrapper words (`env`,
  `command`, `nohup`, `time`, `sudo`, `exec`, `nice`), recurse into
  `sh -c` / `bash -c` / `eval` bodies and `$(…)` / backticks, then deny only if
  the basename is exactly `git`. The `jj git …` carve-out then needs no
  exception list — `jj git export` resolves to program `jj`. Full rule and
  residual gaps: [15](docs/15-verb-mapping.md) §4.
- Denial text comes from the verb mapper; it is the product.
- **Bypass:** rather than denying outright, the guard returns `{kind:'ask'}`
  with the same reason, so the user can grant one call. It must check the
  session's approval policy first — under `never`, an `ask` auto-rejects and the
  harness replaces our message with "the user rejected tool bash". See
  [17](docs/17-bypass-and-approval.md).

The guard **never rewrites arguments** — DSH excludes input rewriting by design
([11 §1](docs/11-verified-dsh-api-contract.md)) — and never fabricates output.
This is the "loud, not silent" decision from
[02](docs/02-git-blocking-at-tool-call-level.md), now enforced by the platform.

#### A denial has **two** channels, not one

**Verified by source trace, and it changes the design.** A `deny` reaches the
model as `Error: <reason>` — but the denied call is then run through the
`tools/post-execute` waterfall anyway, so a second listener can attach extra
context to that same result.

The trace:

1. `prepareExecution` on a denial returns
   `{kind:'post-result', result: <materialized "Error: …">}`
   (`dsh-tools/lib/index.js:3243-3256`).
2. That reaches `finalizeScheduledExecution` (`:3125`).
3. Which **always** calls `postExecute(exec, projected)` (`:3368`) — there is no
   error branch that skips it.
4. `postExecute` (`:3503`) runs the waterfall and, for a plain `accept`,
   returns the original result with the listener's contexts merged in:

   ```js
   const additionalContexts = [...(result.additionalContexts ?? []), ...decisionContexts];
   return this.markCanonical(exec, {
     ...result,
     ...(decision.content !== void 0 ? { content: decision.content } : {}),
     ...(additionalContexts.length > 0 ? { additionalContexts } : {}),
   });
   ```

So the guard splits its message:

| Channel                                           | Carries                                                         | Bound                                      |
| ------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `reason` on the `deny`                            | the actionable command — what the model needs _now_             | ≤ 240 chars ([25](docs/25-prompt-copy.md)) |
| `additionalContexts` on a `post-execute` `accept` | the explanation — why Git is wrong here, what `jj` does instead | no practical bound                         |

**Four implementation constraints**, all from the same code. The first two
would silently defeat the feature; the second two would silently change the
message:

- **Never `exec.deferContext()` from the pre-execute listener.** Context deferred
  there is read only on the _dispatch_ path
  (`dsh-tools/lib/index.js:3333-3340`), so on a denial it is **silently
  dropped** — no error, no warning, no context.
- **Never throw to deny.** A throwing listener produces a `final-result`
  (`:3267-3271`), which skips `postExecute` entirely (`:3126`). Throwing
  therefore loses the second channel _and_ is the same mistake that makes a
  detector bug break every `bash` call.
- Return `{kind:'accept', additionalContexts:[…]}` with **no `value`**. The
  `value` branch throws `tools/post-execute cannot replace the value of a failed
  result` on an error result (`:3517-3518`).
- Prefer `accept` over `{kind:'block', feedback}`. `block` recomputes
  `error.message` from the feedback (`:3506-3513`), **discarding the guard's
  `reason`** — the terse actionable line the whole design rests on.

So the guard's contract is: **return `deny`, never throw, never `deferContext`,
and attach the explanation from `post-execute` with a plain `accept`.**

This is the outcome [34](docs/34-probe-plan.md) §5 called the most useful
possible: the terse denial stays terse, and the teaching rides with it into the
same next request.

### 5.3 Verb mapper (`verbs.ts`)

A pure table: Git gesture → `jj` equivalent → denial message. The authoritative
version is [15](docs/15-verb-mapping.md).

Shape:

```ts
type Verdict = { kind: "deny"; reason: string; verb: string } | { kind: "allow" };
```

Properties it must have:

- **Deterministic** — same input, same message.
- **Actionable** — every denial names a runnable `jj` command.
- **Testable** — a table, so each row is a test case.

### 5.4 `jj-hunk` bridge (`hunk.ts`)

Wraps the binary. Two supported input forms, in priority order:

1. **`--query '<hunkset expression>'`** — preferred. The expression is stable
   in _intent_ across working-copy changes.
2. **`--spec-file <json|yaml>`** — for a confirmed, one-shot selection.

**Never accept hunk IDs across turns.** IDs are SHA-256 over the materialized
comparison and regenerate on any edit
([13 §6](docs/13-empirical-verification.md)).

Commands to expose: `list`, `split`, `commit`, `squash`. Always `--format json`
for `list`; parse, never scrape text.

**`jj-hunk` reports success on failure, so every exit code is suspect.** Four
cases measured on 0.5.1, all exiting **0**:

- an empty `--query` returns `{"files":[]}`;
- an empty query on `split` no-ops silently;
- a **stale spec creates an empty commit** carrying the user's message while
  leaving every change uncommitted;
- a multi-revision revset (`-r 'all()'`) silently diffs the merged set.

Each must be a plugin-side pre-check producing a hard error
([26](docs/26-preflight-and-error-taxonomy.md) §B.1) — `HUNK_SPEC_STALE` in
particular is undetectable from the exit code. Never combine `--query` with
`--include` / `--exclude` / `--files`; scope goes inside the query via `path:`.
Write any spec file **outside** the working copy.

`jj-hunk` also has **no version flag** — `--version`, `-V` and `version` all
error — so version detection is tiered (`cargo install --list` → capability
probe → unknown ⇒ warn and proceed).

Binary resolution: `jj-hunk` on `PATH`, else a configured absolute path, else
refuse with an install instruction. **Decision D3.**

### 5.5 Tool surface — **decided: the full first-class set**

Eleven tools, all returning structured JSON via `defineTool`, built on `jj`'s
native `-T 'json(self)'` templates. The specification is
[18](docs/18-tool-surface.md): `jj_status`, `jj_log`, `jj_diff`, `jj_op_log`,
`jj_new`, `jj_describe`, `jj_squash`, `jj_bookmark`, `jj_op_restore`,
`jj_hunk_list`, `jj_hunk_apply`.

Publishing (`jj git push`) is deliberately **not** a tool — it goes through
`bash` where the user sees it, or through a future tool that requires the same
explicit-bypass treatment as [17](docs/17-bypass-and-approval.md).

The schema budget (~1,000–1,500 tokens on every request) is the main cost;
[18](docs/18-tool-surface.md) proposes staging the rollout without changing the
design.

### 5.6 Context injection — **mechanism resolved**

`ctx.systemPrompt` (`@deepseek-ai/dsh-system-prompt`), the same registry the
harness's own policy subsystems use. Two contributions, both conditional and
both free outside a `jj` workspace:

- a **section** at `getSectionOrder('TOOL_BASH')` — the rule;
- a **runtime context** at order `130` — the state, materialised as a durable
  user-role snapshot.

Full specification: [22](docs/22-context-injection.md). The canonical template is
`dsh-user-approval`'s own registration.

### 5.7 Write protection for `.jj/` and `.git/` — **D6: yes**

Two predicates, one listener.

**a. Path writes** — `read`/`write`/`edit` targeting `.jj/**` or `.git/**` are
denied; reads are allowed.

**b. Destructive `bash` commands** — a destructive verb (`rm`, `rmdir`, `mv`,
`truncate`, `shred`, `find … -delete`) whose resolved path argument names the
**exact component** `.git` or `.jj` (trailing slash allowed). Never a prefix:
`.gitignore`, `.gitattributes`, `.gitkeep`, `.github/` are not triggers.

**Why (b) exists — measured.** `rm -rf .git` in a colocated repo is
unrecoverable, and it invokes no Git program, so the Git-verb guard allows it
with high confidence ([21](docs/21-guard-evasion.md) §e):

```
$ rm -rf .git            exit 0, no git process
$ jj status              Internal error: The repository appears broken
$ jj op log              same error
$ jj git init --colocate Error: The target repo already exists
```

`.jj/repo/` holds the operation store, but the **commit objects live in `.git`**.
Deleting it deletes the object store the backend reads, and the recovery command
(`jj op restore`) cannot run because the op log is unreadable. In a
**non-colocated** repo the same command is a no-op.

Posture follows [17](docs/17-bypass-and-approval.md): `ask` when a human is
present — de-colocating a repo is a legitimate, deliberate act — and `deny` with
our own reason under `never`. The message must say the operation is
**unrecoverable** and name the non-destructive alternative. That alternative is
verified to exist in 0.46:

```
$ jj git colocation disable
Convert into a non-colocated Jujutsu/Git repository
This moves the Git repository that is at the root of the Jujutsu workspace into
the .jj directory. Once this is done you will no longer be able to use Git
commands directly in the Jujutsu workspace.
```

That is the whole intent behind `rm -rf .git`, done safely and reversibly with
`jj git colocation enable`. Every other command cited as a remedy in this repo
was checked the same way (`jj op restore`, `jj workspace add`,
`jj bookmark list`, `jj file annotate`, `jj resolve --list`, `jj revert`,
`jj duplicate`, `jj tag set`, `jj sparse set`, `jj bisect run`, `jj absorb`) —
all exist in 0.46.

When a path argument contains an expansion (`rm -rf "$PWD/.git"`,
`rm -rf $(jj workspace root)/.git`), the path is unresolvable: **ask, never
allow.**

### 5.9 Teaching the model — split the prose from the manual

The current design pays ~200 words of `jj` prose on **every** prompt assembly.
[28](docs/28-teaching-and-interaction-surfaces.md) §1 shows the harness has a
better structure:

| Content                                                            | Home                                              | Cost                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the **rule** ("Git is intercepted; use `jj`")                      | `ctx.systemPrompt.section`                        | every assembly — it must be there before the first Git command                          |
| the **state** (root, `@`, conflicts, `jj-hunk`, the manual's name) | `ctx.systemPrompt.context`                        | every assembly — it changes                                                             |
| the **manual** (how to drive `jj`)                                 | a `jujutsu` **skill** via `ctx.skills.register()` | one catalog line, republished after compaction; the body loads only when the model asks |

The skill catalog is published as a durable user message at `agent/pre-step`,
digest-gated so it is published once and then only on change, one line per skill — **and republished after compaction**
(`name: description`, description truncated at 500 chars). Bodies cost nothing
until loaded. `dsh-web-app`'s own composition documents "repository plugins" as
the intended global-layer registrants for exactly this.

**A skill cannot replace the rule.** The model loads a skill only _after_
deciding it needs one, and it decides from the catalog line — too late to stop
the first `git commit`. So the rule and the state stay in `ctx.systemPrompt`;
only the manual moves.

**And the split is not a token saving — an earlier draft of this section claimed
"roughly 5×", which is wrong.** Measured ([32](docs/32-probe-results-teaching.md) §Q3):

|                                     | Tokens                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| the real injection (89 words)       | ≈ 138                                                    |
| the manual that can move (38 words) | ≈ 57 saved                                               |
| the catalog line that replaces it   | 30–77                                                    |
| **net**                             | **−26 with a short description, +20 with a 40-word one** |

(The 89-word figure predates the pointer line; the state block is 102 words
today, +13.)

Break-even is a description of ~35 words. So the split is **token-neutral**, and
the honest reason to ship it is different: a skill lets the body be as thorough
as it proves useful — the operation log, change IDs, the conflict model, the
Git-to-`jj` table — instead of capped at 38 words, at zero cost in the sessions
that never load it.

**The body is a card, not the manual.** `jj help <subcommand>` and
`jj help -k <topic>` are local, free, and always match the installed binary, so
flags copied into the skill pay twice and drift on the next upgrade. The card
keeps only what the binary cannot answer — the intent map, the plugin's eleven
tools, the hunk query language — points at `jj help` for the rest, and measures
~670 words instead of ~1,185 (`test/skill.test.ts` caps it at 800). A skill the
model never notices is one it never loads, so the state block carries one
pointer line (13 words) naming it; that is the per-request price of
discoverability, and it is the only part of the manual paid every assembly.

Two consequences:

- **Write the skill description as a routing rule, under ~35 words.** Not a
  summary. Above that the split costs more than it saves.
- **"Published once per session" is wrong.** The catalog is _not_ protected from
  compaction, but `catalogHistory` reads the append-only log rather than the
  surface, so a compacted catalog is **republished as an update at the next
  `agent/pre-step`**. Only a context-overflow retry leaves one request without
  it — a bounded, transient loss.

Registration: `ctx.skills.register({name, description, content, source, …})`
inside `ctx.inject(['skills'], …)`. Service absence degrades silently, and a
project skill of the same name wins — both acceptable.

### 5.10 Slash commands — user-only, and that is the point

`ctx.commands.register({name, description, handler})`. **Commands are
user-only**, confirmed three ways in [28](docs/28-teaching-and-interaction-surfaces.md)
§2: the source map has exactly one member `{kind:'user'}`, every `execute`
caller in the tree is a client, and no prompt-section slot advertises them. A
plugin cannot invoke one either.

That is the right shape for the D2 bypass, which today requires editing config:

- `/jj bypass on|off|status` — the explicit grant, mid-session, by the human.
- `/jj install-hunk` — the user-owned mutation, and the manual equivalent of
  `hunkInstall: 'auto'`.

Both write back to the model through `invocation.agent.followup(...)`. A plain
`/jj` status command is **rejected** — no decision attaches to it.

### 5.11 Asking the user a structured question

`ctx.userQuestions.ask(request)` is a **public service method**, not gated
behind the `ask_user` tool, with a structured request
(`{id, question, options:[{label, description}], multiSelect?}`) and a
structured answer. It fails closed with `CALLER_NOT_LIVE`, `DELEGATED_CALLER`
(the agent is owned by another) or `NO_PROVIDER`.

It is a better fit than `approval` for the `jj-hunk` install offer, which needs
_three_ answers, not a yes/no — see [19](docs/19-jj-hunk-provisioning.md).

It is **not** a replacement for `approval` in the guard. The two differ
structurally:

|                         | `approval.request`                                                  | `userQuestions.ask`           |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------- |
| Answer                  | `allowed-once \| rejected \| cancelled \| unavailable` — no channel | structured, arbitrary options |
| From a subagent         | works (no live-root check)                                          | throws `DELEGATED_CALLER`     |
| Under `policy: 'never'` | auto-rejects                                                        | unaffected                    |

So: **install offer → `userQuestions`; the guard's bypass → stays `approval`**,
because a subagent's `git commit` must not throw.

### 5.12 A project can switch the plugin off

`{"enabled": false}` in a `.dsh-jujutsu.json` at any directory level disables the
plugin for that subtree; `{"enabled": true}` re-enables it below such a marker.
The nearest marker wins. Absent marker means automatic activation on `.jj`.

The same file carries the two opt-in behaviours, each independently overridable
in both directions: `{"adopt": true|false}` (§5.14) and `{"forceJj": true|false}`
(§5.15). `{"enabled": false}` vetoes both — a project that turned the plugin off
has not consented to a repository write or a refusal.

The harness has no project-scoped plugin config and `jj`'s per-repo config lives
outside the workspace, so this is the plugin's own convention — see
[docs/29](docs/29-state-config-and-sandbox-surfaces.md) §3 for the evidence. A
malformed marker is ignored rather than obeyed, so it cannot silently disable
the guard.

### 5.13 `.volatile()` is required for config to be visible at all

Exporting `Config` is **not** enough to make the row appear in Settings.
`dsh-settings` projects `volatileForm(schema)` and **drops the entry entirely
when no field is volatile** ([29](docs/29-state-config-and-sandbox-surfaces.md) §2).
Every field in §6 must therefore carry `.volatile()`.

`.volatile()` also means "live-editable without remount" and "path-addressable";
a non-volatile path throws `Config field "x" is not volatile`.

**But do not claim the UI renders controls from the schema alone.** `autoGenerate`
has **no shipped consumer** — there is no schema→controls generator. Real controls
require a hand-written browser half, and this plugin now has one:
`src/client/panel.ts`, built to `lib/client.js`, registered on
`plugins.bundle.config`. It draws each field as a `Switch` or a
`SegmentedControl` chosen by the field's kind, and reads the same `Config` rather
than duplicating the field list. Marking the fields volatile is still required —
it is what makes them live-editable and path-addressable.

### 5.14 Adopting a plain Git repository

A Git repository with no `.jj` can be handed to Jujutsu by running
`jj git init --colocate`, which adds `.jj` beside `.git` and imports the
history. Git tooling keeps working and the branch history is unchanged; `.git`
does gain jj's export refs (`refs/jj/keep/*`). The undo is `rm -rf .jj` — **not**
`jj git colocation disable`, which instead moves `.git` into the jj store and
removes Git from the working tree. Full detail:
[37](docs/37-git-compatible-adoption.md).

Three decisions, each of which could have gone the other way:

- **A setting, not behaviour.** It is the only thing this plugin does that writes
  to the user's repository, so it is `adoptGitRepos`, default `false`.
- **A static probe, not a trial run.** `jj git init --colocate` is not
  idempotent — a second run exits 1 with `The target repo already exists` — and
  a failed import is not obviously reversible. The probe reads files and refuses
  before anything is written. It refuses LFS and every other content filter
  (jj runs no filters, so a git-crypt repository would be committed as
  plaintext over the encrypted blob), sparse checkouts (jj reads paths outside
  the cone as deleted and commits the deletion), shallow clones, linked
  worktrees and symlinked `.git` (where `jj git init` creates a second,
  unrelated repository) and half-finished Git operations. **Submodules do not
  block adoption** — `jj git init --colocate` leaves them to Git, and jj works
  beside them in practice.
- **Refusals are reported, not silent.** The session state carries the blocker
  and `context.ts` renders one sentence naming it. A refusal that said only "jj
  is not available" would read as a missing install.

A project can override the setting with `{"adopt": true|false}` in
`.dsh-jujutsu.json` (§5.12).

### 5.15 Forcing Jujutsu outside a workspace

`forceJj` (off by default) turns the plugin from silent into active in a
directory with no Jujutsu workspace: a `jj` invocation that needs one is refused
with the command that creates it, instead of being allowed to fail with `There
is no jj repo in "."`. The setting is global; `{"forceJj": true|false}` in a
project marker overrides it in either direction, and `{"enabled": false}` vetoes
it.

Off by default because the plugin's invisibility outside a workspace is a
feature: a user who never asked for Jujutsu should not find `jj` refused in an
unrelated directory. On, it fires before the binary does, so the model spends one
call on an instruction instead of two on an error and a recovery.

The refusal is deliberately narrow:

- **Only `jj` invocations.** Git keeps its own settings (`guard`, `readOnlyGit`,
  `bypass`); `jj-hunk` is a different binary and is untouched.
- **Only commands that need a workspace.** `jj git init --colocate`,
  `jj git clone`, `jj config`, `jj help`, `jj util`, `jj version`, `--version`,
  bare `jj`, and every `-R <path>` form are allowed — a guard that refused
  `jj git init` would be a dead end. The classification lives in
  `src/verbs.ts#classifyJjInvocation`.
- **Not where adoption was refused.** If the preflight recorded an adoption
  `blocked` (LFS, sparse checkout, shallow clone, …), `jj git init` is the
  corruption the probe exists to prevent; the refusal says "use Git here
  instead" rather than naming an initialisation that would damage the
  repository.
- **Not bypassable.** `bypass: "allow"` answers "run this refused Git command
  anyway" — there is no command to run here, so there is nothing to approve.

**When it is off, the plugin is invisible.** With no workspace and no
`forceJj`, nothing is recorded and both the guard and the prompt stay out of the
way. **When it is on, the git→jj refusals stay exactly as they were** — the mode
changes only what happens with no workspace to guard.

## 6. Config schema

```ts
export const Config = z.object({
  // A boolean, not an enum of deny/off: two states, and an enum of two renders
  // as a segmented control offering "Deny" and "Off" as if they were peers.
  guard: z.boolean().default(true).volatile(),
  // D2 — read-only Git is denied by default, with an explicit bypass
  readOnlyGit: z
    .union([z.const("deny"), z.const("ask"), z.const("allow")])
    .default("ask")
    .volatile(),
  bypass: z
    .union([z.const("deny"), z.const("ask"), z.const("allow")])
    .default("ask")
    .volatile(),
  rememberBypass: z.boolean().default(true).volatile(),
  // D3 — jj-hunk provisioning
  jjPath: z.string().default("jj").volatile(),
  jjHunkPath: z.string().default("jj-hunk").volatile(),
  hunkInstall: z
    .union([z.const("ask"), z.const("never"), z.const("auto")])
    .default("ask")
    .volatile(),
  // §5.9 — teach the manual via a skill rather than the system prompt
  teachSkill: z.boolean().default(true).volatile(),
  injectContext: z.boolean().default(true).volatile(),
  // §5.14 — adopt a plain Git repository by running jj git init --colocate.
  // Off by default: it is the only setting that makes the plugin write to the
  // user's repository, and the compatibility probe refuses the shapes jj cannot
  // represent (LFS, sparse checkouts, shallow clones, linked worktrees,
  // in-progress Git operations). Submodules are not a blocker.
  adoptGitRepos: z.boolean().default(false).volatile(),
  // §5.15 — refuse jj outside a workspace instead of letting it fail. Off by
  // default: the plugin stays invisible in directories it was never asked about.
  forceJj: z.boolean().default(false).volatile(),
});
```

Every field is `.volatile()` — see §5.12: without it the whole row is dropped
from Settings. Every field is also a decision the user can reverse without a
code change. No secrets, so no `.role('secret')` and no credential fields.

`bypass` and `readOnlyGit` are specified in
[17](docs/17-bypass-and-approval.md); `hunkInstall` and `jjHunkPath` in
[19](docs/19-jj-hunk-provisioning.md); `teachSkill` in
[28](docs/28-teaching-and-interaction-surfaces.md); `adoptGitRepos` in
[37](docs/37-git-compatible-adoption.md); `forceJj` in §5.15 and
[docs/26](docs/26-preflight-and-error-taxonomy.md).

## 7. Behaviour matrix

| Workspace              | `bash` command                 | Result                                 |
| ---------------------- | ------------------------------ | -------------------------------------- |
| none                   | anything                       | `next()` — invisible                   |
| none, `forceJj`        | `jj log`                       | **deny** with `jj git init --colocate` |
| none, `forceJj`        | `jj git init --colocate`       | allow — the way out                    |
| none, adoption blocked | `jj log`                       | **deny** — "use Git here instead"      |
| `jj` (colocated)       | `jj new`                       | allow                                  |
| `jj` (colocated)       | `jj git push`                  | allow — carve-out                      |
| `jj` (colocated)       | `git commit`                   | **deny** with `jj commit` / `jj new`   |
| `jj` (colocated)       | `git status`                   | **deny** with `jj status` (D2)         |
| `jj` (colocated)       | `pnpm build`                   | allow                                  |
| `jj` (`--no-colocate`) | `git status`                   | **deny** — no `.git` exists            |
| `jj`                   | `jj-hunk split …`              | allow (bridge, or via bash)            |
| `jj` (colocated)       | `write` → `.jj/working_copy/…` | **deny** — points at `jj op restore`   |
| `jj` (colocated)       | `write` → `.git/HEAD`          | **deny**                               |
| `jj` (colocated)       | `read` → `.jj/repo/…`          | allow                                  |

## 8. Failure modes

| Failure                              | Required behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jj` not on `PATH`                   | Detection still works (`.jj` is a directory). Guard still works. Only the hunk bridge degrades, with an install instruction.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `jj-hunk` not installed              | Refuse hunk operations with the exact `cargo install` line. Never silently fall back to `jj split -i` — that needs a TTY.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `jj` identity unconfigured           | **Fail closed on commands that _create_ a commit** (`jj_new`, `jj_hunk_apply` split/commit/squash), warn once per session elsewhere. Measured: such commits exit 0, get an empty author, and are **refused by `jj git push` locally** — and configuring the identity afterwards does not repair them. `jj metaedit --update-author` does. Note the boundary: `jj_describe` and `jj_squash` **preserve** an existing author and need not be refused. Full evidence: [26](docs/26-preflight-and-error-taxonomy.md) §A.5, [33](docs/33-probe-results-jj.md) §3. |
| Detection throws (permissions, race) | **Fail open**: `next()`. A broken detector must not block the user's shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Workspace root unresolvable          | Fail open, and log once per session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Command text unparseable             | Fail open, and log. Never deny on a parse error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Denial is wrong                      | The message must be actionable so the model recovers in one step. This is the highest-severity class of bug: a bad denial blocks real work.                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Principle: fail open, deny narrowly.** The guard's job is to catch the
habitual Git command, not to be a security boundary.

Refined in [26](docs/26-preflight-and-error-taxonomy.md) §C, because the slogan
alone does not decide the hard cases. The discriminator is **who pays for the
mistake**:

> Fail open on anything that only limits what the plugin itself can do. Fail
> closed on anything that would let the user create a durable artifact they
> cannot easily undo.

Three rules follow:

1. **Never block the shell.** Any failure inside the guard listener resolves to
   `next()`. The guard denies on _classification_ only, never on _environment_ —
   it needs no `jj`, no `jj-hunk`, no identity, no version check.

   **This is not a preference, it is a requirement.** Verified in the source: a
   throwing `tools/pre-execute` listener is caught by the registry and converted
   into a **tool error** (`dsh-tools/lib/index.js:3221-3225` → `:3198`). A
   detector bug that throws would therefore break _every_ `bash` call, not just
   the one being classified. The listener body is `try { … } catch { return
   next(); }` with no exceptions to that rule.

   Related: `info.code` on a `deny` is **not model-visible** — only `reason` is.
   Every guard reason must be self-contained.

2. **Never silently degrade to something worse.** A missing `jj-hunk` must not
   become `jj split -i` — that needs a TTY and a headless agent driving it will
   _hang_, not fail.
3. **Never let an avoidable permanent artifact be created silently.**
   Commit-creating operations with an unconfigured `jj` identity are **refused,
   not warned about**: the damage is done by the very call that emits the
   warning, is invisible until push, and persists after the config is fixed.

The apparent contradiction — "fail open" versus refusing `jj_hunk_apply` — is
resolved by distinguishing the **plugin** from the **operation**: the plugin
fails open (everything else keeps working), while the specific operation that
cannot be done correctly fails closed with its install command.

## 9. Compatibility

- Node ≥ 24; DSH `^0.2.0-rc.1 || >=0.2.1-0 <0.3.0`; Cordis `~4.0.4`.
- **Release state.** `@deepseek-ai/dsh` `latest` and `next` on npm are both
  **`0.2.0-rc.2`** — the installed version, and the one every harness claim
  here was read from. `0.2.1-alpha.2` exists on the `alpha` tag, and the whole
  package set moves in lockstep to it (`dsh-tools`, `dsh-system-prompt`,
  `dsh-user-approval`, `dsh-fs`, `dsh-shell`, `dsh-workspace`,
  `dsh-agent-instructions` all publish `0.2.1-alpha.2`). The alpha's internals
  were **not** inspected; the peer range above admits it, and the seams this
  plugin depends on are unchanged in `0.2.0-rc.2`.
- `jj` floor: **0.46.0** (the version everything here was measured against).
  `jj git init` colocation-by-default and `jj sparse` are the features that
  matter; both predate 0.46 but the floor should be what is tested.
- `jj-hunk` floor: **0.5.1** — the ID contract changed here, and earlier
  releases use content/context hashes with no legacy fallback.

## 10. Testing

Three layers, in `test/`:

1. **Unit — verb mapper.** Table-driven; one case per row of
   [15](docs/15-verb-mapping.md), plus the false-positive corpus from
   [12 §B](docs/12-risks-and-open-questions.md).
2. **Unit — guard.** A fake `exec` and a stubbed detector; assert the exact
   `PreToolDecision` returned. No filesystem, no binaries.
3. **Integration — real repos.** Build fixtures with the real `jj`:
   non-colocated, colocated, secondary workspace, nested. Assert the full
   behaviour matrix in §7. These are the tests that would have caught the
   inverted `.jj`/`.git` assumption in the first draft of docs 03/09.

Acceptance criteria are enumerated in
[12 §H](docs/12-risks-and-open-questions.md).

## 11. Rollout

1. Land the guard + verb mapper behind `guard: 'off'` default; ship with
   `'deny'` only after the verb table has been exercised against a real repo.
2. Install into the `web` profile as a bundle via `plugin_manager`
   `install_bundle`. Live profiles apply without restart.
3. Add the `jj-hunk` bridge once the binary is confirmed present.

## 12. Decisions

| #   | Decision                                         | Status                                                                                                                                           |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Is Git blocked outright, or only inside `jj`?    | **Settled** — block inside a `jj` workspace; invisible outside.                                                                                  |
| D2  | Are read-only Git commands denied too?           | **Settled** — denied by default, with an **explicit per-call bypass** through the harness approval channel. [17](docs/17-bypass-and-approval.md) |
| D3  | `jj-hunk` provisioning                           | **Settled** — offer to install via `cargo`, on an explicit yes. [19](docs/19-jj-hunk-provisioning.md)                                            |
| D4  | Policy-only or first-class `jj` tools?           | **Settled** — both; the full first-class set. [18](docs/18-tool-surface.md)                                                                      |
| D5  | Detection scope                                  | Per call, cached per workspace root, invalidated on `jj git init` / `jj workspace add`.                                                          |
| D6  | Guard `read`/`write`/`edit` on `.jj/` internals? | **Settled** — deny writes to `.jj/**` and `.git/**`; allow reads. §5.7                                                                           |
| D7  | `jj` version floor                               | 0.46.0.                                                                                                                                          |
| D8  | Spelling                                         | `dsh-jujutsu` in the package, "Jujutsu (`jj`)" in prose.                                                                                         |

Remaining open questions, with the reasoning behind each: [12](docs/12-risks-and-open-questions.md).
