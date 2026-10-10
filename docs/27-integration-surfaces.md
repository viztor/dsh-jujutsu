# 27 — Integration surfaces: where `dsh-jujutsu` can plug in

**Method.** Every event and service below was extracted from the installed
`0.2.0-rc.2` source: events from `@mode`-annotated declarations across all
`@deepseek-ai/dsh-*` packages, services from `super(ctx, "<name>")` in each
service class. Package-relative citations throughout.

**Why this exists.** The design in [`SPEC.md`](../SPEC.md) uses five seams. The
harness exposes **90 events** and **~95 services**. This document maps the rest
and says which of them would make the plugin better rather than merely bigger.

## 1. The event surface

90 events carry a documented mode. Only five matter to the current design; the
interesting question is which of the other 85 should.

| Mode | Count | What a listener can do |
|---|---|---|
| `waterfall` | 21 | transform the value, or veto by not calling `next()` |
| `emit` | 55 | observe only |
| `parallel` | 2 | all listeners run, none decides |
| `serial` | 2 | ordered, one at a time |
| `bail` | 4 | first listener to answer stops the chain |

### Already used

| Event | Mode | Use |
|---|---|---|
| `tools/pre-execute` | waterfall | the guard |
| `tools/post-execute` | waterfall | available; declined for read-only Git ([14](14-decision-log.md) §R10) |
| `tools/execute` | waterfall | around-dispatch; not needed |
| `system-prompt/assemble` | waterfall | deliberately not used — targeted `section`/`context` registration is the supported path |
| `approval/request` | waterfall | read indirectly through the `approval` service |

### Candidates worth taking

| Event | Mode | What it offers | Verdict |
|---|---|---|---|
| `agent/created` | serial | per-session init, **awaited** before creation resolves; `SessionHeader.cwd` is available | **USE** — the correct home for the 14 preflight checks ([30](30-lifecycle-and-observability-surfaces.md)) |
| `session/created` | emit | fires first, but **synchronously** — async work is not awaited and rejections are only logged | **CONSIDER (seed only)** — too early to complete anything |
| `agent/turn-stopping` | serial | end-of-turn, **`void` return — not a waterfall, cannot deny** | **REJECT** for the warnings I first proposed (see below); CONSIDER for one per-session alert via `agent.inject` |
| `fs/write-intent` | waterfall | single-slot decision before **any** `ctx.fs.writeText` | **CONSIDER** — defence in depth, but see §3: it cannot deny |
| `fs/edit-intent` | waterfall | the same for `editText` | **CONSIDER** — same limitation |
| `user-questions/request` | waterfall | structured questions to the user | **CONSIDER** — better shape than approval for the `jj-hunk` install offer ([28](28-teaching-and-interaction-surfaces.md)) |
| `agent/pre-step` / `agent/request` | waterfall | per-step and per-request hooks | **REJECT** — `pre-step` runs *after* assembly and only appends messages; `agent/request` cannot mutate messages by contract. `systemPrompt.context` is strictly fresher |
| `tools/result` | emit | every settled tool result | **REJECT** — the guard already sees what it needs |
| `tools/ptc-dispatch-log` | waterfall | PTC sub-dispatch logging | **REJECT** — no PTC surface here |
| `skills/change`, `commands/change` | emit | catalog churn | **REJECT** — nothing to do |
| `fs/observed` | emit | every authoritative read/write observation | **REJECT** — interesting for cache invalidation, not worth it |
| `workspace/session-activity` | waterfall | session activity for a workspace | **REJECT** — client-facing |

### Two corrections to my own first draft of this table

**`agent/created`, not `session/created`.** `session/created` is an `emit` fired
synchronously; a listener's async work is not awaited and its rejections are
only logged. `agent/created` is `serial` and **awaited before creation
resolves**, with `AgentLoop` holding queued input — and `SessionHeader.cwd` is
already available there, so no tool call is needed to learn the root.

**This makes `try/catch` load-bearing a second time.** A throw in an
`agent/created` listener **fails session creation**, not one tool call. The
guard's mandatory `try { … } catch { return next(); }`
([24](24-implementation-plan.md) §3.6) has a sibling here, and it is a stronger
requirement because the blast radius is the whole session.

**`agent/turn-stopping` cannot carry the advisory I proposed.** It is `serial`
with a `void` return — not a waterfall, so it cannot deny. The Claude Code
`Stop` bridge does not return a denial either; it calls
`agent.steer(createUserMessage(…))`. The better channel is `agent.inject`, which
queues context *without waking the driver* — `steer` burns a whole model step.

And both warnings I suggested are wrong on the merits:

- *"you have uncommitted `jj` changes"* — in Jujutsu the working copy `@` is
  **always** a commit with a diff. This would fire on every turn.
- *"`@` is still empty"* — legitimate after any read-only turn. A turn is the
  wrong unit for it.

The only legitimate use of this seam is **one actionable alert per session** —
broken repo, unreadable `.jj`, conflicted `@` — delivered through `inject`.

## 2. The service surface

~95 services register. Grouped by what they are:

| Group | Examples | Verdict for this plugin |
|---|---|---|
| **Capability seams** | `tools`, `fs`, `shell`, `systemPrompt`, `approval`, `subprocess`, `jobs` | `tools`/`fs`/`shell`/`systemPrompt`/`approval` **in use**; `jobs` CONSIDER |
| **Policy** | `sandboxPolicy`, `permissionPresets` | **CONSIDER** — `sandboxPolicy` closes an open unknown ([29](29-state-config-and-sandbox-surfaces.md)) |
| **Workspace/session** | `workspaceRegistry`, `sessions`, `sessionQuery`, `sessionProjections`, `sessionReferenceResolver` | `workspaceRegistry` CONSIDER; the rest REJECT |
| **State** | `storage`, `spillStore` | `storage` **CONSIDER** — would let the bypass allowlist survive a session |
| **Model-facing extension** | `skills`, `commands`, `userQuestions`, `agentPresets` | **CONSIDER** — see [28](28-teaching-and-interaction-surfaces.md) |
| **Presentation/UI** | `slots`, `uiSession`, `uiConversation`, `commandUi`, `configForms`, `settingsSchema` | **TAKEN** — `slots` + `configForms` drive the admin panel ([29](29-state-config-and-sandbox-surfaces.md) §4). The session/conversation UI services remain REJECT |
| **LLM/telemetry** | `llm`, `tokenMeter`, `otel`, `productAnalytics`, `sessionTelemetry` | **REJECT** |
| **Auth/account** | `credentials`, `authorization`, `deepseekAccount` | **REJECT** |
| **Harness internals** | `pluginManager`, `invariants`, `hmr`, `loader` | `invariants` **USE** in tests; rest REJECT |
| **Client/transport** | `connection`, `clientModules`, `webServer`, `fileUpload` | **REJECT** |
| **Agents** | `agents`, `agentTeams`, `subagents` | **REJECT** — unless `jj` state must reach subagents |

## 3. The `fs` intent waterfalls — and what they cannot do

This is the most interesting find and the easiest to get wrong.

`fs/write-intent` and `fs/edit-intent` are **single-slot decision waterfalls**
(`dsh-fs/lib/types/index.d.ts:28`, `:36`):

> Calling `next()` yields the bare provider's unconditional write; the first
> listener that returns an intent owns the decision rather than composing with
> peers.

The decision type is not a union with a deny arm:

```ts
type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion };
```

**There is no deny.** The intent is a *freshness precondition*, not a veto:
`createIfAbsent` fails on an existing target, `replaceIfVersion` fails on a
version mismatch. Omitting the intent means unconditional create-or-overwrite.

Two consequences:

1. **The `.jj`/`.git` write protection stays on `tools/pre-execute`**, where a
   denial can carry a real `reason`. Forcing a failure here would surface as
   `FS_NOT_OBSERVED` or `FS_STALE_VERSION` — an accurate code with a confusing
   story, and no room for "run `jj op restore`".
2. **But it is the only hook that catches writes not made through the
   `write`/`edit` tools** — a plugin calling `ctx.fs.writeText` directly. If a
   real bypass channel is found, returning `{kind:'createIfAbsent'}` for an
   existing `.jj` path blocks it. Ugly, and worth it only as defence in depth.

### The template it reveals

`dsh-fs-observation-policy` is the closest thing in the harness to what
`dsh-jujutsu` is:

> Event-only filesystem observation policy; **it registers no service**. A weak
> owner/target map records every authoritative presence/absence observation,
> single-slot intent listeners derive guards from that state, and the provider
> performs the atomic freshness/no-clobber check. Without this plugin, tools
> retain the bare provider's unconditional mutation behavior.

That is the **policy-plugin shape**: no service of its own, a `WeakMap` of
observations, listeners on existing waterfalls, decisions enforced by the
provider. `dsh-jujutsu` is the same kind of thing for a different domain, and
should be written in that shape — including the `inject` list, which that
package documents as deliberately empty because it reads no services.

The family to read before writing ours:

| Package | Domain | Mechanism |
|---|---|---|
| `dsh-fs-observation-policy` | read-before-edit | `fs/*-intent` waterfalls |
| `dsh-sandbox-policy` | confinement | runtime context + `sandboxPolicy` |
| `dsh-session-checkpoint-policy` | checkpointing | `tools/*` + session events |
| `dsh-tool-call-timeout-policy` | timeouts | `tools/execute` |
| `dsh-permission-presets` | permission knobs | service + events |
| `dsh-spill-policy` | output retention | `tools/post-execute` |

## 4. Gaps in the current design that a better seam would close

| # | Gap | Better seam | Impact |
|---|---|---|---|
| G1 | ~200 words of `jj` prose on **every** assembly | a **skill** the model loads on demand | recurring token cost → on-demand |
| G2 | the D2 bypass is a config edit | a **slash command** (`/jj bypass on`) | a user can act mid-session without editing YAML |
| G3 | the `jj-hunk` install offer goes through `approval` | `userQuestions` structured question | a yes/no prompt instead of a permission grant |
| G4 | the bypass allowlist dies with the session | `storage` | survives a restart, per workspace |
| G5 | 14 preflight checks run lazily, per call | `agent/created` (awaited) | cheaper and earlier; better error ordering |
| G6 | guard config is raw YAML in a patch file | `settingsSchema` / `configForms` | real controls in Settings |
| G7 | `policyWorkspaceRoot` unknown ([24](24-implementation-plan.md) §6 #7) | `sandboxPolicy` service | closes a correctness gap in detection |
| G8 | no end-of-turn signal | `agent/turn-stopping` | "your `@` is still empty" at the right moment |

Each is investigated in [28](28-teaching-and-interaction-surfaces.md),
[29](29-state-config-and-sandbox-surfaces.md) and
[30](30-lifecycle-and-observability-surfaces.md).

## 5. What we deliberately do not use

- **Session and conversation UI** (`uiSession`, `uiConversation`, `commandUi`).
  Still rejected. The plugin now *has* a client half — `slots` and
  `configForms` carry the admin panel ([29](29-state-config-and-sandbox-surfaces.md)
  §4) — but a `jj` status panel inside the conversation is a different project.
- **`llm` and `llm/stream`.** Reaching into the model call would repeat the
  `dsh-heal` mistake of patching a seam that is not meant to be patched.
- **`system-prompt/assemble`.** An expert waterfall over the whole assembly;
  targeted registration is supported and sufficient.
- **`tools/execute`.** It can only change `exec.signal`; there is nothing to
  gain.
- **`agents`/`subagents`.** `jj` state is per-workspace, and a subagent inherits
  the workspace. Revisit only if a subagent is observed escaping the guard.
- **`mcpResources`.** Exposing `jj` state as an MCP resource is a solution
  looking for a problem while the eleven tools exist.

## 6. Recommended order

1. **G7 — `sandboxPolicy`.** It closes a known correctness gap in the guard.
   Nothing else is worth doing while detection can resolve the wrong directory.
   *Settled by [29](29-state-config-and-sandbox-surfaces.md) §3: the guard can
   read it, and in every ordinary session it agrees with `session.header.cwd`
   anyway. The service matters only for a cwd-less session.*
2. **G5 — preflight at `agent/created`.** Moves 14 checks out of the hot path
   and fixes the ordering of error reporting. Behind a `.jj` stat gate, so a
   plain-Git session costs one `ctx.fs.stat`.
3. **G1 — a skill.** Split the 200 words: rule and state stay in
   `ctx.systemPrompt`; the manual moves to a `jujutsu` skill. A strict
   reduction with no new failure mode.
4. **G3 — `userQuestions`** and **G2 — a command.** User-facing quality of life.
5. **G4, G6, G8.** **G4 is now rejected** — there is no per-workspace store
   ([29](29-state-config-and-sandbox-surfaces.md) §1). **G6 is reduced** to
   marking the config fields `.volatile()` so the row is not dropped; real
   controls need a browser half this plugin does not have. **G8 is reduced** to
   one per-session alert via `agent.inject`.

Items 1 and 2 change correctness and cost. Items 3–5 change ergonomics. Ship in
that order.

## 7. Verification status

| Claim | Status |
|---|---|
| 90 events with documented modes; the counts in §1 | **VERIFIED** — extracted from `@mode` annotations across the installed packages |
| ~95 services; the grouping in §2 | **VERIFIED** — extracted from `super(ctx, "<name>")` |
| `fs/write-intent` / `fs/edit-intent` are single-slot decision waterfalls | **VERIFIED** — `dsh-fs/lib/types/index.d.ts:28`, `:36` |
| `FsWriteIntent` has no deny arm | **VERIFIED** — `dsh-fs/lib/types/types.d.ts:111` |
| `dsh-fs-observation-policy` registers no service and is event-only | **VERIFIED** — its module doc |
| The per-surface verdicts in §2 | **ANALYSIS**, not measurement — they are judgement calls about this plugin's needs |
| A skill is catalog-only until loaded; the catalog is one line, digest-gated, and republished after compaction | **VERIFIED** — [28](28-teaching-and-interaction-surfaces.md) §1, `dsh-tool-skill/lib/index.js:216-235, 293-295` |
| Commands are user-only; a plugin cannot invoke one either | **VERIFIED** — [28](28-teaching-and-interaction-surfaces.md) §2, `CommandSourceMap` has one member |
| `ctx.userQuestions.ask()` is public and not tool-gated; it throws `DELEGATED_CALLER` for an owned agent | **VERIFIED** — [28](28-teaching-and-interaction-surfaces.md) §3 |
| The guard can read the same `policyWorkspaceRoot` the bash tool computes | **VERIFIED** — [29](29-state-config-and-sandbox-surfaces.md) §3 |
| There is no per-workspace store; the only durable medium is global to the DSH home | **VERIFIED** — [29](29-state-config-and-sandbox-surfaces.md) §1 |
| Exporting `Config` is insufficient — every field needs `.volatile()`; `autoGenerate` has no consumer | **VERIFIED** — [29](29-state-config-and-sandbox-surfaces.md) §2 |
| `agent/created` is awaited; `session/created` is not | **VERIFIED** — [30](30-lifecycle-and-observability-surfaces.md) §1 |
| `agent/turn-stopping` is `serial` with a `void` return and cannot deny | **VERIFIED** — [30](30-lifecycle-and-observability-surfaces.md) §2 |
| Guard denials cannot be re-rendered; `deny` has no display-only field | **VERIFIED** — [30](30-lifecycle-and-observability-surfaces.md) §7 |
| `presentCall` / `presentResult` have zero call sites in the shipped tree | **VERIFIED** — same section |
| Whether a `deny` can carry `additionalContexts` in-band | **UNVERIFIED** — [28](28-teaching-and-interaction-surfaces.md) §5 names the probe |
| Whether `agent.inject` at `turn-stopping` reaches the model on the next turn | **UNVERIFIED** — [30](30-lifecycle-and-observability-surfaces.md) §7 |
| The actual token delta between the ~200-word injection and a ~40-word catalog line | **UNVERIFIED** — measurable only once both exist |
