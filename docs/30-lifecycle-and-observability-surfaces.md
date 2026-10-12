# 30 — Lifecycle and observability surfaces

**Your question:** five harness surfaces might be better homes for work
`dsh-jujutsu` currently does lazily, inside the tool call it is intercepting.
What does each one actually offer a plugin?

**Scope:** the lifecycle/observability seams only. The guard's own contract
([02](02-git-blocking-at-tool-call-level.md), [17](17-bypass-and-approval.md),
[21](21-guard-evasion.md)) and the preflight taxonomy ([26](26-preflight-and-error-taxonomy.md))
are unchanged except where noted.

**Toolchain:** DSH `0.2.0-rc.2`. Every claim below is read from the installed
`lib/index.js` / `lib/types/**/*.d.ts`; citations are package-relative.
Nothing here was executed against a live session — the _shape_ of each surface is
**VERIFIED** (source), the _payoff_ of moving work is not.

Related: [11](11-verified-dsh-api-contract.md) · [22](22-context-injection.md) ·
[24](24-implementation-plan.md) · [26](26-preflight-and-error-taxonomy.md).

---

## 0. Summary of verdicts

| #   | Surface                 | Declared by   | Mode                          | Verdict                                                                 |
| --- | ----------------------- | ------------- | ----------------------------- | ----------------------------------------------------------------------- |
| 1a  | `session/created`       | `dsh-session` | emit (sync)                   | **CONSIDER** — seed only; cannot await                                  |
| 1b  | `agent/created`         | `dsh-agent`   | serial (awaited)              | **USE** — the per-session preflight home                                |
| 2   | `agent/turn-stopping`   | `dsh-agent`   | serial (awaited)              | **CONSIDER** for one advisory; **REJECT** as a denial channel           |
| 3a  | `agent/pre-step`        | `dsh-agent`   | waterfall                     | **REJECT** — runs after assembly; message-append only                   |
| 3b  | `agent/request`         | `dsh-agent`   | waterfall                     | **REJECT** — cannot carry model-visible content                         |
| 4   | `dsh-workspace-changes` | —             | service + `session/event`     | **REJECT** as a `jj_status` source; **CONSIDER** as a narrow complement |
| 5a  | guard denial rendering  | —             | —                             | **REJECT** — no seam exists                                             |
| 5b  | `jj_*` tool rendering   | `dsh-tools`   | `presentCall`/`presentResult` | **CONSIDER**, low priority; no in-tree consumer                         |

Two premises in the question are wrong, and both matter:

- `dsh-agent-tool-presentation` is **not** a rendering package. It selects
  whether the model sees tool schemas or a `run_code` SDK (§5).
- `dsh-workspace-changes` does **not** listen on `tools/execute`, and does not
  track "files changed in this session" — it tracks _per top-level turn_ (§4).

---

## 1. `session/created` and `agent/created` — per-session initialization

### 1.1 What `session/created` is

| Fact               | Value                                                               | Source                                   |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------- |
| Declared in        | `dsh-session`                                                       | `dsh-session/lib/types/index.d.ts:42`    |
| Signature          | `(this: Scoped<Session>, session: Session): void`                   | same                                     |
| Mode               | `emit` — no return channel                                          | `dsh-session/lib/types/index.d.ts:40`    |
| Scope filter       | agent-scoped listeners see only sessions entered through that agent | `dsh-session/lib/types/index.d.ts:36-41` |
| Untagged listeners | admitted — a plugin registered on a plain `ctx` sees every session  | `dsh-scope/README.md:77`                 |
| Escape hatch       | `{ global: true }` bypasses filtering (harness's own use)           | `dsh-session/lib/types/invariant.js:180` |
| Async work         | **not awaited** — a returned promise's rejection is only logged     | `dsh-session/lib/index.js:1795-1798`     |
| Sync throw         | **vetoes publication** and rolls back with a paired disposal        | `dsh-session/lib/types/index.d.ts:28-31` |

Firing point: `dsh-agent-loop/lib/index.js:1750`, inside the creation
transaction's `publish()`:

```
1748  detachSession = agent.ctx.sessions.enter(session);
1749  detachAgent   = loopCtx.agents.enter(agent, parentAgent);
1750  agent.ctx.sessions.announce(session);          // → session/created, SYNC
1752  await loopCtx.agents.announce(agent, source, abort.signal);  // → agent/created, AWAITED
```

`dsh-agent-loop/lib/index.js:1748-1752`.

### 1.2 The workspace root is available there

The question assumes the root is only reachable via
`exec.agent.session.header.cwd` on a tool call. That is false:

```ts
interface SessionHeader {
  readonly cwd?: string; // "Absolute working directory the session was created in (if any)."
}
```

`dsh-session/lib/types/types.d.ts:58-69` (`cwd` at `:69`). It is validated
absolute — a relative `meta.cwd` throws
(`dsh-session/lib/index.js:1045-1048`). So `session.header.cwd` is a direct field
read in the listener, with **no** tool call involved.

Two caveats: it is **optional** (`cwd?:`), and the harness's own convention is to
skip subagent sessions entirely —

```js
function eligible(session) {
  const { cwd, origin, delegationDepth } = session.header;
  return origin === "subagent" || (delegationDepth ?? 0) > 0 ? void 0 : cwd;
}
```

`dsh-workspace-changes/lib/index.js:984-987`. A preflight that must run for
subagents too cannot copy that predicate unchanged.

### 1.3 Timing relative to the first request

| Guarantee                                                                                                                    | Source                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Everything registered through `agentCtx` exists **before** `session/created`, `agent/created`, and the first prompt assembly | `dsh-agent/lib/types/index.d.ts:88-97`           |
| `agent/created` listeners "run in order and are **awaited before creation resolves**"                                        | `dsh-agent/lib/types/runtime-types.d.ts:215-226` |
| "AgentLoop **holds queued input** until all listeners finish"                                                                | same, `:217`                                     |
| A throw or rejection **fails creation** and skips later listeners                                                            | same, `:217-218`                                 |

Order: factory setup → `session/created` (sync) → `agent/created` (awaited) →
first prompt assembly → first request.

**Consequence.** `session/created` is early enough but cannot _complete_ async
work before the first request: its emit is synchronous and promise rejections are
swallowed. `agent/created` is the only per-session hook that is both early
enough and awaited.

`agent/created` also carries `source: SessionStartSource` —
`'startup' | 'resume' | 'clear' | 'compact'` (`dsh-agent/lib/types/runtime-types.d.ts:105,227-232`).
A resumed session re-runs preflight, which is correct: the workspace may have
moved since.

### 1.4 Verdict

| Surface           | Verdict                  | Reasoning                                                                                                                                                                                                       |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/created` | **CONSIDER (seed only)** | The only place to capture `session.header.cwd` synchronously before anything else, and the only place a _veto_ is even representable. But it cannot await, so it cannot be the preflight's completion boundary. |
| `agent/created`   | **USE**                  | Awaited before creation resolves, with queued input held; carries `payload.agent` and therefore `agent.session.header.cwd`; distinguishes `startup` from `resume`.                                              |

**The blocking objection to using `agent/created`, and its answer.** Its listener
contract says a throw **fails creation**. That is strictly worse than the guard's
failure mode ([26](26-preflight-and-error-taxonomy.md) §B.2: a throwing
`pre-execute` listener becomes a tool error). So the listener must be
`try { … } catch { /* record unknown */ }` with **no** path that throws —
[26](26-preflight-and-error-taxonomy.md) §A.6 rule 2 ("a cache miss is not a
failure … only a _positive_ observation closes a door") is exactly the required
posture, and it is now load-bearing rather than advisory.

**Cost.** `agent/created` is awaited, so probes run before the user sees a
session start. Gate on the cheap filesystem check first (P8: one
`ctx.fs.stat(<root>/.jj)`) and return immediately outside a `jj` workspace. That
keeps [26](26-preflight-and-error-taxonomy.md) §A.6 rule 1's spirit ("the plugin
is inert on a machine with no `jj`") while moving the expensive probes off the
first tool call.

### 1.5 Concrete spec change

| Document                                      | Change                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [26](26-preflight-and-error-taxonomy.md) §A.6 | Replace the "once per **session**, lazily on first `jj`-workspace touch" trigger for P1–P5, P8–P11, P13 with "at `agent/created`, after a `.jj` stat gate; cached by **workspace root**, shared across sessions in the same process". |
| [26](26-preflight-and-error-taxonomy.md) §A.6 | Keep P6 per-call (see §2.5) and P12 per-call. Keep P7 per-call **for the guard** — the guard needs the _effective_ cwd from `exec.arguments.workdir` (`dsh-tool-bash/lib/index.js:293-299`), which `agent/created` cannot know.       |
| [26](26-preflight-and-error-taxonomy.md) §A.6 | Add rule 3: "The `agent/created` listener never throws. A throw fails session creation, not one tool call."                                                                                                                           |
| [24](24-implementation-plan.md) §3.2          | `detect.ts`'s cache key changes from session id to absolute root for the shape checks, matching [26](26-preflight-and-error-taxonomy.md) §A.6.                                                                                        |

---

## 2. `agent/turn-stopping` — the end-of-turn seam

### 2.1 The exact contract

| Fact           | Value                                                                          | Source                                           |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Signature      | `(this: Scoped<Agent>, payload: {agent, turn, signal}): Promise<void> \| void` | `dsh-agent/lib/types/runtime-types.d.ts:387-391` |
| Mode           | **`serial`**, not waterfall                                                    | `dsh-agent/lib/types/runtime-types.d.ts:385`     |
| Return channel | **none** — the return type is `void`                                           | same, `:391`                                     |
| Dispatch       | `await this.dispatch.serial("agent/turn-stopping", {turn, signal})`            | `dsh-agent-loop/lib/index.js:999`                |
| Gate           | only when `turnEnds && this.inbox.nextStep.length === 0`                       | `dsh-agent-loop/lib/index.js:997-1003`           |

**It is not a waterfall and it cannot deny.** The declaration's own doc states
the mechanism for objection:

> "Awaited before the boundary commits — a listener that objects steers
> (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs
> another step, none closes the turn. Data decides, so listener order cannot
> change the outcome."

`dsh-agent/lib/types/runtime-types.d.ts:366-386`.

Because it is `serial`, listeners _are_ awaited — an async `jj` read here is
legitimate. The harness's own shipping use is exactly that:
`dsh-workspace-changes/lib/index.js:1092-1094` awaits `recorder.stopping(turn)`.

### 2.2 What the Claude Code bridge actually does

```js
ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
  const merged = await runPoint("Stop", "", stopPayload(agent), { agent, turn, signal });
  if (merged.decision === "deny") {
    const text = merged.reason ?? "continue: blocked by Stop hook";
    agent.steer(
      createUserMessage({
        content: [{ type: "text", text }],
        source: CONTEXT_SOURCE,
      }),
    );
  }
});
```

`dsh-hooks-claude-code/lib/index.js:292-308`. The hook's "deny" is **translated
into `agent.steer`** — the listener returns nothing. `createUserMessage` comes
from `@deepseek-ai/dsh-llm` (`dsh-hooks-claude-code/lib/index.js:3`).

So the shape available to `dsh-jujutsu` is the same one: an awaited end-of-turn
listener plus `Agent`'s own delivery methods. Those are two, and they differ in a
way that matters:

| Method                  | Semantics                                                                                                                                                                                                                | Source                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `agent.steer(message)`  | "An idle driver starts a turn; a running driver consumes it at its next step boundary." Re-opens the turn → the model acts **now**.                                                                                      | `dsh-agent/lib/types/runtime-types.d.ts:194-200` |
| `agent.inject(message)` | "Queue model-facing context for the next pre-step **without waking the driver** … idle drivers leave it pending until follow-up or steering wakes them. It may miss a request whose pre-step already claimed its batch." | `dsh-agent/lib/types/runtime-types.d.ts:202-209` |

`steer` costs a whole extra model step. `inject` costs nothing now and lands at
the next pre-step — i.e. at the start of the user's next turn.

### 2.3 Could it warn "you have uncommitted `jj` changes"?

**No — the premise is wrong for `jj`.** In Jujutsu the working copy `@` _is_ a
commit; "uncommitted changes" is its diff against `@-`, and that is the normal
resting state of every `jj` workspace, always. A per-turn warning on it fires on
every turn of every session and carries no information. [SPEC §5.1](../SPEC.md)
already says this ("the working copy `@` is always dirty").

### 2.4 Could it warn "the working copy `@` is still empty"?

Technically yes, semantically weakly. A turn that only read files legitimately
leaves `@` empty; warning at every such turn is noise. The state is only
actionable at a **publish or handoff boundary**, not at a turn boundary. A turn
is not the right unit for this check.

The one genuinely actionable per-turn state is not an emptiness check at all —
it is the three closed conditions from [26](26-preflight-and-error-taxonomy.md)
Part C: a broken repo (P9), an unreadable `.jj` (P8), or a conflicted `@` (P12)
that the model has not yet seen. Those are _alerts_, not _state_, and they are
worth at most one message per session.

### 2.5 Verdict

| Use                                                                                                    | Verdict                        | Reasoning                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deny / block the turn                                                                                  | **REJECT**                     | No return channel exists. `serial` means order-independent, not vetoing.                                                                                                                                                                                                                                         |
| Per-turn "uncommitted changes"                                                                         | **REJECT**                     | `@` is always dirty in `jj`. Noise by construction.                                                                                                                                                                                                                                                              |
| Per-turn "`@` is still empty"                                                                          | **REJECT** as a per-turn check | A read-only turn legitimately leaves `@` empty. Wrong unit.                                                                                                                                                                                                                                                      |
| Replace the `tools/post-execute` identity advisory (P6, [26](26-preflight-and-error-taxonomy.md) §A.5) | **REJECT**                     | The existing trigger is precise (`bash` stderr contains `Name and email not configured`) and the existing channel (`accept` + `additionalContexts`, `dsh-tools/lib/types/index.d.ts:465-469`) already reaches the model in-band, attached to the call that caused it. `turn-stopping` would be later and vaguer. |
| One actionable alert, at most once per session, via `agent.inject`                                     | **CONSIDER**                   | The only legitimate use. `inject` (not `steer`) is mandatory: `steer` burns a model step to deliver a notice the model did not ask for.                                                                                                                                                                          |

### 2.6 Concrete spec change

Add a new subsection to [26](26-preflight-and-error-taxonomy.md) Part B:

> **B.4 `agent/turn-stopping` advisory (not an error).** Code
> `JJ_WORKSPACE_ALERT`. At most once per session. Fires from an
> `agent/turn-stopping` listener when the session's first turn ends **and** the
> workspace is in one of the closed states (`JJ_REPO_BROKEN`,
> `JJ_REPO_UNREADABLE`, or a conflicted `@`). Delivered with `agent.inject`, never
> `agent.steer`. It never denies — `agent/turn-stopping` has no return channel
> (`dsh-agent/lib/types/runtime-types.d.ts:387-391`).
>
> Explicitly **not** in scope: an "uncommitted changes" or "`@` is empty"
> warning. `@` is always dirty in `jj`; an empty `@` is a legitimate outcome of a
> read-only turn.

And amend [22](22-context-injection.md) §4/§6: the "do not use `agent.steer`"
row stays, but must name `agent.inject` as the correct delivery method for any
future session-level notice — otherwise the row reads as "no delivery method
exists".

---

## 3. `agent/pre-step` and `agent/request`

### 3.1 The contracts

|           | `agent/pre-step`                                                        | `agent/request`                                  |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Signature | `(payload: {agent, messages: UserMessage[], turn, step, signal}, next)` | `(payload: {agent, turn, step, signal}, next)`   |
| Returns   | `PreStepDecision`                                                       | `LlmCallConfig`                                  |
| Mode      | waterfall                                                               | waterfall                                        |
| Source    | `dsh-agent/lib/types/runtime-types.d.ts:304-310`                        | `dsh-agent/lib/types/runtime-types.d.ts:327-333` |
| Mode line | `:302`                                                                  | `:325`                                           |
| Dispatch  | `dsh-agent-loop/lib/index.js:911-918`                                   | `dsh-agent-loop/lib/index.js:1179-1185`          |

```ts
type PreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: UserMessage[]; startsRequestSeries?: true };
```

`dsh-agent/lib/types/runtime-types.d.ts:92-100`.

`agent/request`'s own doc forecloses the question:

> "**Model-visible content must use logged channels; this waterfall cannot mutate
> messages.**"

`dsh-agent/lib/types/runtime-types.d.ts:318-319`. It replaces the frozen call
configuration (provider, model, reasoning effort, max tokens); a returned config
missing provider or model throws (`dsh-agent-loop/lib/index.js:1185`).

### 3.2 Ordering — `pre-step` runs after assembly

```
907  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
908  const sections = renderContextSections(assembly);
909  const context  = this.runtimeContext.project(joinContextSections(sections), sections);
911  const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal },
915    () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
```

`dsh-agent-loop/lib/index.js:907-918`.

So the pipeline per step is: **assemble → project runtime context → `agent/pre-step`
→ `agent/request` → LLM call**. `pre-step` cannot influence the assembly it
follows.

### 3.3 `ctx.systemPrompt.context` already re-evaluates per assembly

| Fact                                                                                 | Source                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `PromptContext.text` is "Static text or a provider evaluated for **each assembly**." | `dsh-system-prompt/lib/types/index.d.ts:77-78` |
| Registered via `SystemPrompt.context(context)`                                       | `dsh-system-prompt/lib/types/index.d.ts:258`   |
| The assembled contexts are projected into a durable user-role message per step       | `dsh-agent-loop/lib/index.js:908-918`          |

Because `assemble()` is called once per step, a `context` provider registered
there is evaluated **per step** — fresher than per-turn, and it costs nothing
when it returns `""` ([22](22-context-injection.md) §5.2).

### 3.4 Verdict

**Both REJECT, and they add nothing.**

- `agent/request` cannot carry model-visible content at all — by explicit
  contract.
- `agent/pre-step` runs _after_ assembly, so it cannot replace the `context`
  registration. It could only append an extra synthetic user message on top of
  the one the runtime context already produces — the same `jj` state, twice, in
  the durable log, on every step.
- The existing `context` provider is already per-assembly, which is strictly
  fresher than per-turn. Moving `jj` state to `pre-step` would make it _less_
  frequent, not more.

The one capability `pre-step` has that `context` does not is
`{kind: 'reject'}` — refusing to enter a step. That is a cost/steering lever,
not a context lever, and `dsh-jujutsu` has no reason to reject a step. Worth
recording as a deliberate non-use so the question is not re-opened.

### 3.5 Concrete spec change

[22](22-context-injection.md) §4 gains two rows:

| Surface          | What it is                                                                | Use for us?                                                                                                     |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `agent/pre-step` | waterfall, post-assembly; `{kind:'enter', messages}` or `{kind:'reject'}` | **no** — runs after assembly; append-only; would duplicate the `context` provider in the durable log every step |
| `agent/request`  | waterfall over the frozen call config                                     | **no** — "cannot mutate messages" (`dsh-agent/lib/types/runtime-types.d.ts:318-319`)                            |

---

## 4. `dsh-workspace-changes` — what it tracks

### 4.1 What it is

`name = "workspace-changes"` (`dsh-workspace-changes/lib/index.js:973`),
`inject = ["subprocess"]` (`:975`) — it runs `git` through `ctx.subprocess`, **not**
through `ctx.shell`.

Four listeners, and only four (`dsh-workspace-changes/lib/index.js`):

| Listener              | Line    | What it does                                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `session/event`       | `:1080` | `turn/start` → `recorder.start(turn)`; `tool/result` → `observe`; `turn/end` → `end(turn)` |
| `session/disposed`    | `:1089` | forget the recorder and remove its temp dir                                                |
| `agent/turn-stopping` | `:1092` | `await recorder.stopping(turn)` — record **inside** the turn                               |
| `tools/pre-execute`   | `:1095` | `recorder.capture(name, args)`, `await recorder.settled()`, then **always `next()`**       |

**It does not listen on `tools/execute`.** The premise in the question is wrong.
It also never denies, blocks, or rewrites anything — the `pre-execute` listener's
only return is `next()`.

### 4.2 What it tracks: per turn, not per session

```ts
interface WorkspaceChangesSummary {
  turn: number;
  cwd: string;
  files: WorkspaceChangedFile[]; // capped at maxFiles
  total: number;
  added: number;
  deleted: number;
  snapshot?: { before: string; after: string };
}
interface WorkspaceChangedFile {
  path: string;
  display: string;
  added: number;
  deleted: number;
  binary?: true;
  oversized?: true;
}
```

`dsh-workspace-changes/lib/types/types.d.ts:23-44` and `:4-21`.

Two independent sources feed the file list:

| Source              | Mechanism                                                                                                                                                                                                                                                 | Covers                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Git tree diff       | `start()` snapshots the work tree into a **private** object store — copy `.git/index`, `git add --all --ignore-errors` with `GIT_INDEX_FILE` on a scratch index, `git write-tree`; `record()` snapshots again and runs `git diff-tree -r -M -z --numstat` | **every** tool, including `bash`                   |
| Whole-file captures | `capture()` on `tools/pre-execute` before a file-tool mutation, compared at `record()`                                                                                                                                                                    | only the file tools (`read`/`write`/`edit` family) |

`dsh-workspace-changes/lib/types/recorder.js:50-67` (`start`), `:76-92`
(`capture`), `:231-301` (`record`), `lib/types/git.js:108-127` (`snapshotTree`),
`:176-185` (`diffTrees`). The repository's own index, object store, refs and work
tree are untouched — the snapshots land in a `mkdtemp` scratch directory.

### 4.3 Where the data lives, and for how long

| Fact                                                                                                                      | Source                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Served by `ctx.provide("workspaceChanges", {summary, diff})`                                                              | `dsh-workspace-changes/lib/index.js:1044-1047`       |
| `summary(sessionId, seq)` returns `undefined` "once its Session was disposed or when this Host never recorded it"         | `dsh-workspace-changes/lib/types/types.d.ts:84-91`   |
| The only durable artifact is a `workspace/changes` Session event carrying `{turn}` — the summary itself stays on the Host | `dsh-workspace-changes/lib/types/types.d.ts:105-113` |
| Top-level sessions only — `eligible()` returns `undefined` for `origin === 'subagent'` or `delegationDepth > 0`           | `dsh-workspace-changes/lib/index.js:984-987`         |
| Config: `timeoutMs` 30 s, `outputMaxBytes` 8 MiB, `maxFiles` 500, `maxFileBytes` 2 MiB, `diffTimeoutMs` 100 ms            | `dsh-workspace-changes/lib/index.js:977-983`         |

### 4.4 The git dependency is the decisive fact

`locateGitWorkspace` runs
`git rev-parse --show-toplevel --absolute-git-dir --git-path objects` and returns
`null` on `not a git repository` (`dsh-workspace-changes/lib/types/git.js:83-96`).

| Workspace                     | `.git`         | Snapshot available? | Consequence                                            |
| ----------------------------- | -------------- | ------------------- | ------------------------------------------------------ |
| `jj-colocated`                | real directory | **yes**             | turn changes are complete                              |
| `jj-native` (`--no-colocate`) | absent         | **no**              | only file-tool captures; `bash`-made changes invisible |

So its completeness depends on colocation — the exact distinction
[26](26-preflight-and-error-taxonomy.md) §A.7 says changes nothing else about the
plugin's behaviour. Sourcing `jj_status` from it would introduce a native/colocated
behaviour split, violating **R2** ("never silently degrade to something worse",
[26](26-preflight-and-error-taxonomy.md) §C.1).

### 4.5 Verdict

**REJECT as a `jj_status` source. CONSIDER as a narrow, optional complement.**

What it _cannot_ answer, and `jj_status` must:

| `jj_status` fact                                          | Available from `workspaceChanges`?                               |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Current `@` change id / commit id                         | no                                                               |
| `@`'s description                                         | no                                                               |
| Parent chain, `@-`                                        | no                                                               |
| Conflicted flag (P12)                                     | no                                                               |
| Bookmark list                                             | no                                                               |
| Whether `@` is empty _relative to its parent_             | no — it reports "changed since turn start", a different question |
| Repo kind: native / colocated / broken (P8, P9, P10, P13) | no                                                               |

It answers "which files changed during this turn, with line counts and per-file
diffs" — a genuinely different question.

| Relationship                       | Finding                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflict with the plugin           | **none** — different seam (`ctx.subprocess`, not `ctx.shell`), never denies, does not touch `.jj`                                                  |
| Duplicate of the plugin's tracking | **none** — the plugin tracks nothing today ([24](24-implementation-plan.md) §3.2 caches detection only)                                            |
| Complement                         | **yes, narrowly** — a free "files changed this turn" list for a turn-end advisory, _if_ absence is read as "no information", never as "no changes" |

The `CONSIDER` is bounded: it is only usable as an _optional input_ that can be
absent, and the plugin must never let its absence change a claim it makes.

### 4.6 Concrete spec change

| Document                                      | Change                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [24](24-implementation-plan.md) §6            | New unknown: "Do not source `jj_status` from `dsh-workspace-changes`. It is git-only (`locateGitWorkspace`, `lib/types/git.js:83-96`) and per-turn, and its snapshot is absent in a native workspace." |
| [26](26-preflight-and-error-taxonomy.md) §A.6 | Note that P8/P10 remain the plugin's own `ctx.fs.stat` probes and are **not** derivable from `workspaceChanges`, which has no repo-kind notion.                                                        |
| [26](26-preflight-and-error-taxonomy.md) §A.7 | Add: the colocated/native split must not leak into any surface sourced from `workspaceChanges`, because its git snapshot exists only when colocated.                                                   |

---

## 5. Tool-call and tool-result rendering

### 5.1 `dsh-agent-tool-presentation` is not a rendering package

| Fact                | Value                                                                                                                              | Source                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| What it is          | a one-row agent-preset selector                                                                                                    | `dsh-agent-tool-presentation/lib/types/index.d.ts:1-19`  |
| Config              | `{ mode: 'native' \| 'ptc' \| 'both' }`, required                                                                                  | `dsh-agent-tool-presentation/lib/types/index.d.ts:32-41` |
| What `apply` does   | `ctx.tools.presentAs(config.mode)`, waiting for `ptcRuntime` when the mode is not `native`                                         | `dsh-agent-tool-presentation/lib/index.js:41-49`         |
| What the mode means | "How the registry presents its tools to the model" — `native` sends every schema, `ptc` sends only `run_code` plus a generated SDK | `dsh-tools/lib/types/index.d.ts:480-481`                 |

It controls **which form of the tools the model sees**. It has nothing to do with
`presentCall`/`presentResult`, and it is scoped to a preset mount, not to a
plugin ("One row per composition, not one per session",
`dsh-agent-tool-presentation/lib/types/index.d.ts:11`).

### 5.2 The real render-intent contract

| Fact                                                                                            | Source                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ToolDefinition.presentCall?(args): ToolCallView \| undefined`                                  | `dsh-tools/lib/types/index.d.ts:182`                                                                        |
| `ToolDefinition.presentResult?(args, result: ToolResult): ToolResultView \| undefined`          | `dsh-tools/lib/types/index.d.ts:190`                                                                        |
| `defineTool` accepts both, as "Pure pending-state presenter" / "Pure completed-state presenter" | `dsh-tools/lib/types/schema.d.ts:225-239`                                                                   |
| `defineTool` normalizes them and returns `undefined` when args fail validation                  | `dsh-tools/lib/index.js:874-881`                                                                            |
| Call vocabulary                                                                                 | `ToolCallView = GenericCallView \| TerminalCallView \| DiffCallView` (`lib/types/presentation.d.ts:41`)     |
| Result vocabulary                                                                               | `ToolResultView = Generic \| Terminal \| Diff \| Search \| Read \| Web` (`lib/types/presentation.d.ts:130`) |

**It is UI-only by construction.** `GenericResultView.content` is "UI-facing
result content (harness `ContentBlock`s), **reformatted from the model-facing
result**" (`dsh-tools/lib/types/presentation.d.ts:135-144`), and omitting the
method "keeps the pending title and renders the raw result content" (`:126-128`).
The model-facing text is untouched.

The one persisted channel is `output.presentationMeta` — for structured data the
render text cannot losslessly carry; it is "persisted with the session log" and
read back by `presentResult` on live and replay paths alike
(`dsh-tools/lib/types/index.d.ts:112`, `lib/types/schema.d.ts:192`,
`lib/types/presentation.d.ts:250-260`).

### 5.3 What the bash tool passes, and how a denial renders

```js
presentCall: presentBashCall,
presentResult: presentBashResult
```

`dsh-tool-bash/lib/index.js:693-694`.

- `presentBashCall` (`:245-262`) returns a `TerminalCallView` for a foreground
  command, a `GenericCallView` for a background one.
- `presentBashResult` (`:267-286`) returns a **`GenericCallView` with a fenced
  console block** whenever `result.isError` is true (`:273-279`) — which is
  exactly what a denial produces.

The denial itself is built by the registry:

```js
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
if (denialReason !== void 0)
  return await next({
    kind: "post-result",
    exec,
    result: this.materializeFinalResult({
      content: [{ type: "text", text: `Error: ${denialReason}` }],
      isError: true,
      error: { message: denialReason, ...(denialInfo === void 0 ? {} : { info: denialInfo }) },
    }),
  });
```

`dsh-tools/lib/index.js:3241-3256`. This confirms
[26](26-preflight-and-error-taxonomy.md) §0 and adds one fact: the _only_
presenter that ever sees a denial is the bash tool's, and it wraps the same
`Error: <reason>` string in a fenced console card for the UI.

### 5.4 A plugin cannot attach a presenter to another plugin's tool

`ToolRuntime`'s public surface is exactly:

| Method                 | Source                               |
| ---------------------- | ------------------------------------ |
| `register(definition)` | `dsh-tools/lib/types/index.d.ts:636` |
| `restrict(filter)`     | `:644`                               |
| `guard(guard)`         | `:655`                               |
| `get(name, scope?)`    | `:690`                               |
| `schemas(scope?)`      | `:711`                               |
| `executionMode(exec)`  | `:723`                               |
| `execute(exec)`        | `:765`                               |
| `presentAs(mode)`      | `dsh-tools/lib/types/index.d.ts:609` |

There is no override, wrap, or decorate API for another definition's presenters,
and `presentAs` only selects native/ptc/both. `defineTool`'s normalization
(`dsh-tools/lib/index.js:874-881`) applies the _definition's own_ options and
nothing else.

### 5.5 The harness's own display-only channel is `ask`, not `deny`

```ts
type PreToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; info?: ToolErrorInfo }
  | { kind: "cancel" }
  | { kind: "ask"; reason?: string; displayReason?: { en: string; [locale: string]: string } };
```

`dsh-tools/lib/types/index.d.ts:445-460`. The doc is explicit that on `ask` the
`reason` is "the audited approval reason and its optional `displayReason` is the
**localized prompt text**" (`:436-444`). **`deny` has no display-only field.**

`displayReason` is forwarded to the approval service at
`dsh-tools/lib/index.js:3460`. If no approval service exists, or the human
rejects, the outcome is a `deny` whose reason is the harness's own generic
sentence — "the user rejected tool …" (`dsh-tools/lib/index.js:3441-3481`) — and
the plugin's `reason` is lost. [24](24-implementation-plan.md) §3.6 already
accounts for this by returning its own `deny` under the `never` policy.

### 5.6 No shipped consumer invokes the presenters

A full-store search for `.presentCall(` and `.presentResult(` across every `.js`
file in `0.2.0-rc.2` finds **zero call sites**. The only `.js` references are:

- the `defineTool` normalization in `dsh-tools/lib/index.js:874-881`;
- the tool packages declaring their own presenters;
- a comment in `dsh-shell/lib/index.js:7`.

The Web UI builds its cards from its own per-tool logic plus persisted
`presentationMeta` (`dsh-client-ui-tool/lib/client.js:2710`), and never calls a
presenter. So the render-intent vocabulary is a **declared contract with no
in-tree consumer in this install** — the bridge that would call it is not in this
package set.

### 5.7 Verdict

| Question                                                                           | Verdict                    | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make a **guard denial** read better in the UI without changing what the model sees | **REJECT**                 | No seam. The denial renders through `presentBashResult` (`dsh-tool-bash/lib/index.js:267-286`), a definition the plugin does not own; `ToolRuntime` has no presenter-override API (§5.4); `deny` has no display-only field (§5.5); and nothing in-tree would call a presenter anyway (§5.6). The only harness-native display-only channel is `displayReason` on `ask`, which is already reachable and already handled by [24](24-implementation-plan.md) §3.6. |
| Make the eleven `jj_*` tools present structured results nicely                     | **CONSIDER, low priority** | They own their definitions, so `presentCall`/`presentResult` + `output.presentationMeta` are available and cost nothing at runtime. But with no in-tree caller the payoff is **UNVERIFIED**.                                                                                                                                                                                                                                                                   |

Cheap, high-value subset if pursued: `presentCall` returning
`{card:'generic', kind:'read'|'edit'|'other', title, locations}` gives a capable
UI an icon and follow-along for free. Do **not** design a `jj`-specific card —
there is no such arm in the union (`dsh-tools/lib/types/presentation.d.ts:41,130`),
and adding one would require a client plugin.

### 5.8 Concrete spec change

| Document                                      | Change                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [24](24-implementation-plan.md) §3.9          | One line per tool: "declare `presentCall` only; `presentResult` is optional and **UNVERIFIED** — no in-tree consumer invokes either."                                                 |
| [24](24-implementation-plan.md) §6            | New unknown: "Does any shipped UI bridge call `presentCall`/`presentResult`? A full-store grep of `.js` in `0.2.0-rc.2` says no."                                                     |
| [26](26-preflight-and-error-taxonomy.md) §B.2 | Add: the guard's `reason` is the _only_ channel — it is both the model-facing text and the UI text. There is no `displayReason` on `deny` (`dsh-tools/lib/types/index.d.ts:448-450`). |

---

## 6. What moves where

Every row is a behaviour [24](24-implementation-plan.md) / [26](26-preflight-and-error-taxonomy.md)
currently place lazily inside the intercepted tool call.

| Behaviour                                                                    | Today                                                | Move to                                                          | Why                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 `jj` resolvable                                                           | lazy, first `jj`-workspace touch                     | **`agent/created`**                                              | Awaited before the first request; removes a spawn from the first tool call                                                                                     |
| P2 `jj` version + capability probes                                          | lazy                                                 | **`agent/created`**                                              | same                                                                                                                                                           |
| P3 `jj-hunk` resolvable                                                      | lazy                                                 | **`agent/created`**                                              | same                                                                                                                                                           |
| P4 `jj-hunk` version                                                         | lazy                                                 | **`agent/created`**                                              | same                                                                                                                                                           |
| P5 `cargo` present                                                           | lazy                                                 | **`agent/created`**                                              | same                                                                                                                                                           |
| P6 identity                                                                  | re-probed on **every commit-creating call**          | **stays per-call**                                               | Deliberate exception, [26](26-preflight-and-error-taxonomy.md) §A.6; the call is rare and a stale `configured` reproduces the exact failure the check prevents |
| P7 workspace root                                                            | every tool call                                      | **stays per-call for the guard**; `agent/created` root for tools | The guard needs the _effective_ cwd from `exec.arguments.workdir` (`dsh-tool-bash/lib/index.js:293-299`), which is unknowable at session start                 |
| P8 `.jj` present/readable                                                    | lazy per root                                        | **`agent/created`** (first probe), per-root cache                | Also the gate that keeps non-`jj` sessions free                                                                                                                |
| P9 repo not broken                                                           | lazy per root                                        | **`agent/created`**                                              | same                                                                                                                                                           |
| P10 colocated vs native                                                      | lazy per root                                        | **`agent/created`**                                              | same                                                                                                                                                           |
| P11 remote configured                                                        | lazy per root                                        | **`agent/created`**                                              | same                                                                                                                                                           |
| P12 conflicts                                                                | every mutating call                                  | **stays per-call**                                               | Conflicts change on any operation; the probe is one cheap `jj log`                                                                                             |
| P13 primary vs secondary workspace                                           | lazy per root                                        | **`agent/created`**                                              | same                                                                                                                                                           |
| P14 probes via `ctx.shell`                                                   | —                                                    | unchanged                                                        | Invariant, not a trigger                                                                                                                                       |
| Per-session identity warning ([26](26-preflight-and-error-taxonomy.md) §A.5) | `tools/post-execute` `accept` + `additionalContexts` | **stays**                                                        | In-band, attached to the exact call that caused it; a precise stderr trigger                                                                                   |
| `jj` state for the model (root, `@`, conflicted)                             | `ctx.systemPrompt.context`, per assembly             | **stays**                                                        | Already per-step — fresher than any turn-level hook (§3.3)                                                                                                     |
| Turn-end "uncommitted changes"                                               | nothing                                              | **nowhere**                                                      | `@` is always dirty in `jj` (§2.3)                                                                                                                             |
| Turn-end "`@` is empty"                                                      | nothing                                              | **nowhere** as a per-turn check                                  | A read-only turn legitimately leaves `@` empty (§2.4)                                                                                                          |
| One actionable workspace alert per session                                   | nothing                                              | **`agent/turn-stopping` → `agent.inject`**                       | The only legitimate use of that seam; `inject`, never `steer` (§2.5)                                                                                           |
| Guard denial UI text                                                         | `{kind:'deny', reason}`                              | **stays**                                                        | No display-only channel exists (§5.7)                                                                                                                          |
| `jj_*` tool card rendering                                                   | nothing                                              | **`presentCall` on each tool** (CONSIDER)                        | Free, but no in-tree consumer (§5.6)                                                                                                                           |

### The one to move first

**P1–P5, P8–P11, P13: per-session preflight, from lazy-on-first-`jj`-touch to
`agent/created` behind a `.jj` stat gate.**

It is first because it is the only row that fixes a _stated_ property rather than
adding a new one. [26](26-preflight-and-error-taxonomy.md) §A.6 currently claims
these run "once per **session**, lazily on first `jj`-workspace touch" — but a
lazy trigger inside a tool call is not once-per-session, it is
once-per-session-_that-touches-jj_, and it lands 5–8 shell spawns on the first
`jj` tool call, the one call where latency is most visible. `agent/created` is
awaited before the first request, so the work is genuinely once-per-session and
cannot race; the `.jj` stat gate keeps a plain-Git or non-repo session at one
`ctx.fs.stat` and nothing else.

It also carries the one real risk, which the spec must state: `agent/created`
listener failures **fail session creation** (`dsh-agent/lib/types/runtime-types.d.ts:217-218`),
so the listener is the second place in this plugin — after the guard — where a
`try { … } catch { }` is load-bearing rather than stylistic.

---

## 7. Verification status

| Claim                                                                                                                   | Status                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session/created` is `@mode emit`, sync, promise rejection logged not vetoed                                            | **VERIFIED** — `dsh-session/lib/types/index.d.ts:40-42`, `lib/index.js:1793-1797`                             |
| `SessionHeader.cwd` exists and is validated absolute                                                                    | **VERIFIED** — `dsh-session/lib/types/types.d.ts:69`, `lib/index.js:812-815`                                  |
| `agent/created` is `@mode serial` and awaited before creation resolves                                                  | **VERIFIED** — `dsh-agent/lib/types/runtime-types.d.ts:225-234`                                               |
| Publication order is session/created then agent/created                                                                 | **VERIFIED** — `dsh-agent-loop/lib/index.js:1748-1752`                                                        |
| `agent/turn-stopping` is `@mode serial` with a `void` return and no veto                                                | **VERIFIED** — `dsh-agent/lib/types/runtime-types.d.ts:385-391`                                               |
| The Claude Code `Stop` bridge translates deny into `agent.steer`                                                        | **VERIFIED** — `dsh-hooks-claude-code/lib/index.js:292-308`                                                   |
| `agent.steer` re-opens a step; `agent.inject` does not wake the driver                                                  | **VERIFIED** — `dsh-agent/lib/types/runtime-types.d.ts:194-209`                                               |
| `agent/pre-step` is a post-assembly waterfall; `agent/request` cannot mutate messages                                   | **VERIFIED** — `dsh-agent-loop/lib/index.js:907-918`, `dsh-agent/lib/types/runtime-types.d.ts:318-319`        |
| `ctx.systemPrompt.context` text is evaluated per assembly                                                               | **VERIFIED** — `dsh-system-prompt/lib/types/index.d.ts:77-78`                                                 |
| `dsh-workspace-changes` listens only on `session/event`, `session/disposed`, `agent/turn-stopping`, `tools/pre-execute` | **VERIFIED** — `dsh-workspace-changes/lib/index.js:1080,1089,1092,1095`                                       |
| Its summaries are per-turn, top-level-session-only, in-memory, dropped at disposal                                      | **VERIFIED** — `lib/types/types.d.ts:23-44,84-91`, `lib/index.js:984-987`                                     |
| Its git snapshot needs a real `.git` (absent in a native `jj` workspace)                                                | **VERIFIED** — `lib/types/git.js:83-96`                                                                       |
| `dsh-agent-tool-presentation` selects native/ptc/both, not rendering                                                    | **VERIFIED** — `lib/index.js:41-49`, `lib/types/index.d.ts:32-41`                                             |
| `presentCall`/`presentResult` are per-definition and UI-only                                                            | **VERIFIED** — `dsh-tools/lib/types/index.d.ts:182,190`, `lib/types/presentation.d.ts:126-144`                |
| `deny` has no display-only field; `ask` does                                                                            | **VERIFIED** — `dsh-tools/lib/types/index.d.ts:445-460`                                                       |
| No in-tree `.js` invokes `presentCall`/`presentResult`                                                                  | **VERIFIED** (grep, whole store) — the consumer is **UNVERIFIED** to exist anywhere                           |
| Whether `agent/created` preflight is fast enough to not annoy at session start                                          | **UNVERIFIED** — needs a measured spike                                                                       |
| Whether `ctx.fs.stat` at `agent/created` time sees the same root the tool call later computes                           | **UNVERIFIED** — same open question as [24](24-implementation-plan.md) §6 unknown 7                           |
| Whether a `jj` workspace's colocated `.git` produces a _correct_ `workspaceChanges` summary (jj owns `.git/index`)      | **UNVERIFIED** — no run; the mechanism is git-tree-based and jj exports to `.git`, but this was not exercised |
| That `agent.inject` at `turn-stopping` reaches the model on the next turn                                               | **UNVERIFIED** — read from the declaration only, not exercised                                                |
