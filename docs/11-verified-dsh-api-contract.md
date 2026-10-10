# 11 — Verified DSH API contract

**Status:** this is the only document in the set whose claims were read from the
installed source rather than from the conversation

Everything here was read from DSH **`0.2.0-rc.2`** as installed in this
profile. Paths are package-relative.

## 1. Tool policy: the `tools/*` waterfalls

`dsh-tools` declares three waterfalls around every tool call.

### `tools/pre-execute`

```ts
'tools/pre-execute'(
  this: Scoped<ToolRuntime>,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>
): Promise<PreToolDecision>
```

`dsh-tools/lib/types/index.d.ts:47`. Dispatched at
`dsh-tools/lib/index.js:3225`:

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec,
  () => Promise.resolve({ kind: "allow" }));
```

The decision union (`dsh-tools/lib/types/index.d.ts:445`):

```ts
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } };
```

A `deny` becomes the tool result `Error: <reason>` with `isError: true`
(`dsh-tools/lib/index.js:889-899`), which is what the model sees and
self-corrects from.

**Input rewriting is excluded by design.** From the same file's own docs:
*"Input rewriting is excluded because arguments are already logged and
presented."* There is no supported way to rewrite a tool call's arguments or to
substitute the tool handler.

### `tools/post-execute`

```ts
'tools/post-execute'(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>
): Promise<PostToolDecision>
```

`dsh-tools/lib/types/index.d.ts:70`. Decision union at `:465`:

```ts
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] };
```

`block` turns a *successful* call into an error carrying corrective feedback —
the "the command ran, and here is why that was wrong" channel.

### `tools/execute`

Around-dispatch waterfall (`:58`), `(exec: ToolDispatchExecution, next)`. A
wrapper may replace `exec.signal` for its delegated lifetime and nothing else;
the registry re-fuses the caller's signal before the body.

## 2. Monotonic policy: `tools.guard()`

```ts
guard(guard: (exec: ToolExecution) => string | undefined): Disposer
```

`dsh-tools/lib/index.d.ts:646`, implemented at `dsh-tools/lib/index.js:2921`.
Runs **after** the extensible pre-execute waterfall, synchronously. Returning a
string denies the call. Guards are monotonic: no guard can force-allow a call
another guard denied. This is the right primitive for an invariant that must
not be overridable by other plugins.

Related: `tools.restrict({ allow, deny })` restricts by tool **name**
(`dsh-tools/lib/index.js:2900`).

## 3. The execution record

`ToolExecution` (`dsh-tools/lib/types/index.d.ts:216`, `:282`):

```ts
interface ToolExecution {
  readonly callId: ToolCallId;
  readonly rootCallId: ToolCallId;
  readonly token: ToolExecutionToken;
  readonly name: string;          // e.g. "bash", "read", "write", "edit"
  readonly schema?: ToolSchema;
  readonly arguments: unknown;    // parsed, JSON-serializable
  readonly agent?: Agent;
  readonly parent?: ToolExecutionToken;
  readonly signal: AbortSignal;
}
```

Note `arguments`, not `args` — the conversation's `callContext.args.command` is
wrong.

## 4. The idiomatic listener

Copied in shape from the shipping Claude Code hooks bridge,
`dsh-hooks-claude-code/lib/index.js:248`:

```js
ctx.on("tools/pre-execute", async (exec, next) => {
  if (merged.decision === "deny") return { kind: "deny", reason: merged.reason ?? "blocked" };
  if (merged.decision === "ask")  return { kind: "ask", ...(merged.reason !== undefined ? { reason: merged.reason } : {}) };
  return next();
});
```

and its post-execute counterpart at `:265`:

```js
ctx.on("tools/post-execute", async (exec, result, next) => {
  if (merged.decision === "deny") return {
    kind: "block",
    feedback: [{ type: "text", text: merged.reason ?? "blocked" }],
    ...(context ? { additionalContexts: [context] } : {})
  };
  const downstream = await next();
  …
});
```

That bridge is the closest existing analogue to `dsh-jujutsu`: an external
policy system projected onto the harness's tool pipeline. It is worth reading
in full before writing the guard.

## 5. Filesystem: `ctx.fs`

`dsh-fs` declares `FileSystem extends Service`
(`dsh-fs/lib/index.js:58`) — a Cordis service, injected as `ctx.fs`.
Abstract methods, `dsh-fs/lib/types/index.d.ts:138-221`:

```
processPath(target)                  fileUrl(target)
contains(parent, child)              stat(target, signal?)
readText(target, signal?)            lstat(path, opts?)
streamText(target, signal?)          readBytes(target, signal, maxBytes)
listDir(target, signal?)             writeText(target, content, expected?, signal?, sandboxPolicy?)
```

Two consequences:

- **No `exists`.** Use `stat()` and test for `undefined`.
- **`writeText` takes an `FsWriteIntent`** (`expected`). That is the
  read-before-edit token; omitting it loses the observation-policy guarantee.
  The policy package is `dsh-fs-observation-policy`.

Backends: `dsh-fs-local`, `dsh-fs-sandbox`. Model-facing tools:
`dsh-tool-fs`, `dsh-tool-fs-search`.

## 6. Shell: `ctx.shell`

`dsh-shell` is the capability seam; executors are `dsh-bash-local` (plain
`bash -c` with user permissions) and `dsh-bash-sandbox` (same command under OS
confinement). Sandbox packages: `dsh-sandbox`, `dsh-sandbox-local`,
`dsh-sandbox-policy`, `dsh-sandbox-windows-acl`. Model-facing tools:
`dsh-tool-bash`, `dsh-tool-bash-persistent`, plus the PowerShell pair.

The bash tool registers `name: "bash"` via `defineTool` from
`@deepseek-ai/dsh-tools` (`dsh-tool-bash/lib/index.js:487-488`) and injects
`["tools", "shell", "systemPrompt", "shellEnv"]`.

Its source carries the design endorsement for this project
(`dsh-tool-bash/lib/index.js:218`):

> `TODO(permissions): deployment policy belongs in tools/pre-execute and
> sandboxing executors`

## 7. There is no git tool

Searched the installed tree:

- no `@deepseek-ai/dsh-tool-git` package
- no tool registering `name: "git"`
- no `execute_bash`, no `terminal_write`, no `git_commit`, no `git_clone`

Git is reachable **only** as a command run through the `bash` tool. The
conversation's "Option A: disable the git plugin" is not merely suboptimal — it
names a plugin that does not exist.

## 8. No `jj`/Jujutsu plugin exists

No package matching `jj`, `jujutsu`, or `jujutsu` is installed. `dsh-jujutsu`
would be the first.

## 9. Claim-by-claim verdicts

| Conversation claim | Verdict | Basis |
|---|---|---|
| `tools/pre-execute` lifecycle pipeline exists | **VERIFIED** | `dsh-tools/lib/types/index.d.ts:47` |
| `tools/pre-execute` blocks *before* the tool runs | **VERIFIED** | `dsh-tools/lib/index.js:3225` gates dispatch |
| A thrown error is the way to block | **CONTRADICTED** | Return `{kind:'deny', reason}` |
| `ctx.tools.on('tools/pre-execute', …)` | **CONTRADICTED** | `ctx.on('tools/pre-execute', (exec, next) => …)` |
| `callContext.name === 'execute_bash'` | **CONTRADICTED** | Tool is `bash` |
| `callContext.args.command` | **CONTRADICTED** | `exec.arguments` |
| `callContext.bypass(fn)` returns fake stdout | **CONTRADICTED** | Does not exist; input rewriting excluded |
| Disable `@deepseek-ai/dsh-tool-git` in a preset | **CONTRADICTED** | Package does not exist |
| `dsh-hook-protocol` standardises hooks | **VERIFIED** as a package | `@deepseek-ai/dsh-hook-protocol` is installed; its exact contract was not read |
| Plugins should use `ctx.fs`, not `node:fs` | **VERIFIED** | `dsh-fs` service; backends swap |
| `ctx.fs` is a Cordis service | **VERIFIED** | `dsh-fs/lib/index.js:58` |
| `ctx.fs.exists(...)` | **CONTRADICTED** | Use `stat()` |
| `ctx.fs.readText(...)` | **VERIFIED** | `dsh-fs/lib/types/index.d.ts:162` |
| `defineTool` from `@deepseek-ai/dsh-tools` | **VERIFIED** | `dsh-tool-bash/lib/index.js:3` |
| `dsh-bash-local` / `dsh-bash-sandbox` split | **VERIFIED** | both packages installed |
| `dsh-terminal-bash` | **CONTRADICTED** | `dsh-tool-bash-persistent` |
| `fs-observation-policy`, `fs/write-intent` exist | **VERIFIED** | package + strings present |
| `vfs_read` / `vfs_write` tools | **CONTRADICTED** | No such tools |
| "State Snapshot Isolation" branching | **UNVERIFIED** | Not found anywhere |

### Resolved later, by source trace

Added after the initial pass; each was UNVERIFIED here and is now settled. Full
traces in [31](31-probe-results-pipeline.md) and
[33](33-probe-results-jj.md).

| Claim | Verdict | Basis |
|---|---|---|
| A `deny` can carry `additionalContexts` in-band | **VERIFIED — but only via `tools/post-execute`** | `finalizeScheduledExecution` calls `postExecute` unconditionally (`dsh-tools/lib/index.js:3368`); `postExecute` merges the listener's contexts (`:3516, :3527-3531`). The `deny` decision itself has no context field (`lib/types/index.d.ts:445-450`) |
| `exec.deferContext()` from a pre-execute listener reaches the model | **CONTRADICTED on the deny path** — read only on dispatch (`:3333-3340`), silently dropped on a denial | same |
| Throwing from a pre-execute listener is equivalent to denying | **CONTRADICTED** — produces a `final-result` that skips `postExecute` (`:3267-3271`, `:3126`) | same |
| `agent.inject` at `agent/turn-stopping` reaches the model | **VERIFIED** — one step later in the **same turn**; the loop re-reads the inbox and cancels the break (`dsh-agent-loop/lib/index.js:998-1006`) | [31](31-probe-results-pipeline.md) Q2 |
| A throw in an `agent/created` listener fails session creation | **VERIFIED** — the rejection propagates to the session controller; the agent is disposed, not half-constructed (`dsh-agent/lib/index.js:572-585`, `dsh-agent-loop/lib/index.js:1900-1912`) | [31](31-probe-results-pipeline.md) Q3 |
| The guard can read the same `policyWorkspaceRoot` the bash tool computes | **VERIFIED** | [29](29-state-config-and-sandbox-surfaces.md) §3 |
| `jj git init` is colocated by default | **VERIFIED** — measured, `jj` 0.46.0 | [13](13-empirical-verification.md) §1 |
| `jj new` escapes a conflict | **CONTRADICTED** — the conflict propagates into the new commit | [33](33-probe-results-jj.md) §2 |
| `jj describe` / `jj squash` mint an empty author when unconfigured | **CONTRADICTED** — both preserve; only `jj new` / `jj commit` mint | [33](33-probe-results-jj.md) §3 |

## Re-verified against the source checkout

Everything above was read from the installed `0.2.0-rc.2` build. It has since
been re-checked against the **source**, at `~/dev/_refs/deepseek-harness`
(commit `639ed01`, "Merge pull request #5479 … release-dsh-0.2.0-rc.2"). That
checkout is **sparse** — only `packages/llm/` is materialized — so the rest was
read straight from the object store with `git show HEAD:<path>` and
`git grep <pat> HEAD -- <path>`, which needs no working-tree changes.

Every contract this plugin depends on survived the check. The exact citations:

| Contract | Source | Result |
|---|---|---|
| `tools/pre-execute` signature | `packages/core/tools/src/index.ts:153` | `(exec, next) => Promise<PreToolDecision>` — as used |
| `PreToolDecision` union | `packages/core/tools/src/index.ts:607` | `allow` \| `deny{reason, info?}` \| `cancel` \| `ask{reason?, displayReason?}` |
| `ask.reason` is the audited reason, `displayReason` the prompt text | doc comment above the union | matches the guard's split exactly |
| Input rewriting is impossible | same comment: *"Input rewriting is excluded because arguments are already logged and presented"* | confirms the silent-translation finding |
| `PostToolDecision` union | `packages/core/tools/src/index.ts:619` | `accept{content?, value?}` \| `accept{value}` \| `block{feedback}` — all may carry `additionalContexts` |
| `ask` outcome mapping | `serviceAsk`, `:1728-1775` | `allowed-once` → allow; `rejected`/`cancelled`/`unavailable` → deny **with the harness's own reason**, discarding ours |
| Approval policy expression | `packages/interaction/user-approval/src/index.ts:244` | `this.overrideOf(session) ?? this.config.policy ?? 'ask'` — the guard's three-term read, character for character |
| `never` auto-rejects | same file, `:275` | `if (this.effectivePolicy(session) === 'never') return 'rejected'` — why the guard denies instead of asking under `never` |
| `agent/created` is awaited | `packages/core/agent/src/index.ts:550` | `await this.ctx.serial(carrier, 'agent/created', …)` |
| `agent/created` mode | `packages/core/agent/src/runtime-types.ts:261` | `@mode serial`, returns `undefined \| Promise<undefined>` |
| `session/created` is not awaited | `packages/core/session/src/index.ts:55` | returns `void`; callbacks are invoked synchronously |
| `SessionHeader.cwd` is optional | `packages/core/session/src/types.ts:105` | `readonly cwd?: string` — hence the `typeof cwd !== 'string'` guard in preflight |
| `ToolExecution.arguments` is `unknown` | `packages/core/tools/src/index.ts:337` | hence the structural reads rather than a cast |
| `ToolExecution.agent` is optional | same file, `:339` | hence `exec.agent?.session.id` everywhere |
| `CONTEXT_ORDERS` reserves 110 / 115 / 120 | `packages/core/system-prompt/src/index.ts:164` | **130 is free**, as the injection assumes |

Two consequences worth stating plainly:

- **The two-channel denial is not a workaround, it is the intended design.** The
  union documents `reason` as the audited reason and `displayReason` as the
  prompt, and `serviceAsk` replaces the reason only when the approval outcome is
  a non-grant. Splitting the message is what the contract is shaped for.
- **Denying rather than asking under `policy: 'never'` is strictly better**, and
  now provable from the source rather than inferred: `effectivePolicy` returns
  `'rejected'` before any answerer runs, and the `rejected` branch discards
  `ask.reason`.

## Sweep of every name referenced in `SPEC.md` and `docs/`

The individual contracts above were checked by hand. Everything *named* across the
documentation was then swept mechanically against the source, because a doc that
cites a renamed event or service is wrong in a way no single reading catches.

**Events — 32 of 32 exist.** Every event name referenced anywhere in `SPEC.md`
or `docs/` was grepped against `packages/` at `HEAD`:

```
agent/created          agent/disposed        agent/pre-step
agent/request          agent/request-error   agent/turn-stopping
tools/pre-execute      tools/post-execute    tools/execute
tools/ptc-dispatch-log session/created       session/disposed
session/event          system-prompt/assemble  system-prompt/change
fs/write-intent        fs/edit-intent        fs/observed
sandbox/mode           approval/request      approval/asked
approval/decided       approval/policy       user-questions/request
commands/change        command/run           command/done
skills/change          workspace/changes     workspace/session-activity
permission/preset      llm/stream
```

**Services — every one the plugin uses is declared.** Read from the `Context`
interface each package augments:

| Service | Declaration | Source |
|---|---|---|
| `ctx.fs` | `fs: FileSystem` | `packages/fs/fs/src/index.ts:47` |
| `ctx.shell` | `shell: ShellExecutor` | `packages/shell/shell/src/index.ts:32` |
| `ctx.tools` | `tools: ToolRuntime` | `packages/core/tools/src/index.ts:139` |
| `ctx.systemPrompt` | `systemPrompt: SystemPrompt` | `packages/core/system-prompt/src/index.ts:15` |
| `ctx.approval` | `approval: ApprovalService` | `packages/interaction/user-approval/src/index.ts:26` |
| `ctx.userQuestions` | `userQuestions: UserQuestionService` | `packages/interaction/user-questions/src/index.ts:24` |

The documentation also references `ctx.sandboxPolicy`, `ctx.skills`,
`ctx.storage`, `ctx.settings`, `ctx.sessions`, `ctx.commands`,
`ctx.sessionProjections`, `ctx.subprocess`, `ctx.configEditor`,
`ctx.configForms`, `ctx.settingsSchema`, `ctx.agents` and `ctx.storageDomain`.
All resolve in the source; none is load-bearing for this plugin, so they are
recorded as existing rather than as verified contracts.

### What the sweep did *not* find

No event or service name in the documentation was stale. The errors this pass
turned up were all in **`jj` command spellings**, not in the harness surface —
which is the opposite of what I expected going in, and is itself the finding:
the DSH contract had been read carefully from the source, and the `jj` guidance
had been written from recall.
