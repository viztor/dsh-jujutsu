# 31 — Probe results: the pipeline questions

**Method.** Source reading, not execution. DSH `0.2.0-rc.2` as resolved from the
pnpm store, cited package-relative:

| Package | Files read |
|---|---|
| `dsh-tools` | `lib/index.js`, `lib/types/index.d.ts` |
| `dsh-agent-loop` | `lib/index.js` |
| `dsh-agent` | `lib/index.js`, `lib/types/runtime-types.d.ts` |
| `@deepseek-ai/cordis@4.0.4` | `lib/index.js` |

Three claims are open across [27](27-integration-surfaces.md):238-240,
[28](28-teaching-and-interaction-surfaces.md) §5,
[30](30-lifecycle-and-observability-surfaces.md) §7 and
[14](14-decision-log.md) R11. All three resolve from the code; none needed a
live session. Every answer is a closed-union trace, so the residual gaps are
the ones named inline, not gaps in the dispatch logic.

---

## Q1 — Can a `tools/pre-execute` `deny` carry `additionalContexts` in-band?

**Answer: YES — but not on the `deny` decision. The context rides the
`tools/post-execute` waterfall that runs over the denial.**

Two facts that look like one:

1. **On the decision itself: NO.** `PreToolDecision`'s deny arm is
   `{ kind: 'deny'; reason: string; info?: ToolErrorInfo }`
   (`dsh-tools/lib/types/index.d.ts:445-450`). There is no `additionalContexts`
   field to set, and the deny branch never invents one.
2. **On the denial's result: YES.** The deny branch produces an error result and
   returns `{kind:'post-result'}`; `finalizeScheduledExecution` runs
   `postExecute` on that result with no `isError` guard; a `tools/post-execute`
   listener can attach `additionalContexts`, and the loop delivers them to the
   next step.

### The decisive path

| # | Fact | Citation |
|---|---|---|
| 1 | Pre-execute is a waterfall; a returned `deny` supplies `decision.reason` | `dsh-tools/lib/index.js:3225`, `:3241` |
| 2 | The deny branch materializes an error with **only** `content` and `error` — no contexts — and returns `kind: "post-result"` | `dsh-tools/lib/index.js:3243-3257` |
| 3 | `completeScheduledExecution` routes `post-result` straight into `finalizeScheduledExecution` | `dsh-tools/lib/index.js:3125` |
| 4 | `finalizeScheduledExecution` calls `postExecute` unconditionally — no `result.isError` check anywhere in the method | `dsh-tools/lib/index.js:3359-3372` (call at `:3368`) |
| 5 | `postExecute` waterfalls `tools/post-execute` over the denial; the `accept` arm merges `additionalContexts` **and preserves `isError`** | `dsh-tools/lib/index.js:3503-3505`, `:3516`, `:3527-3531` |
| 6 | Materialization preserves contexts through both passes | `dsh-tools/lib/index.js:3591-3596` |
| 7 | The loop's native path hands the finalized result to `acceptContext` with **no `isError` check** | `dsh-agent-loop/lib/index.js:570-572` |
| 8 | `acceptContext` splices into the durable `next-step` inbox | `dsh-agent-loop/lib/index.js:1154` |

So the doc comment's "pipeline failures are already final"
(`dsh-tools/lib/index.js:3320-3322`) is exact and does **not** cover a policy
denial: only `final-result` is final, and a `deny` is not one.

### Where it is lost — four traps

| Trap | Where it is lost |
|---|---|
| `exec.deferContext(ctx)` called from the pre-execute listener | `deferredContexts` is read **only** in `dispatchScheduledExecution` (`dsh-tools/lib/index.js:3333-3340`). The deny path never enters it, so the context is silently dropped. `deferContext` is the *dispatch*-path mechanism, and the PTC executor re-uses it for sub-calls (`dsh-tools/lib/index.js:1388`) — not a pre-execute channel |
| **Throwing** instead of returning `deny` | `prepareExecution`'s catch returns `{kind:'final-result'}` (`dsh-tools/lib/index.js:3267-3271`), and `final-result` goes to `finishScheduledExecution`, which skips `postExecute` entirely (`dsh-tools/lib/index.js:3126`). No contexts, and no post-execute at all |
| Returning `block` from post-execute on the denial | Replaces the denial content and **recomputes** `error.message` from the feedback (`dsh-tools/lib/index.js:3506-3513`), discarding the guard's `reason` |
| Returning `accept` + `value` | Throws `TypeError` because the result is an error (`dsh-tools/lib/index.js:3517-3518`); the throw is swallowed into a generic tool error by `finalizeScheduledExecution`'s catch (`:3370-3371`) |

### Citation correction

[28](28-teaching-and-interaction-surfaces.md) §5 (the "bonus finding") cites
`dsh-tools/lib/index.js:1388` as the place where contexts are "deferred into the
model context for the next request". That line is the `run_code` executor
re-deferring a sub-call's contexts into the **enclosing** execution. The native
tool-call path is `dsh-agent-loop/lib/index.js:572`.

**Confidence: CERTAIN.** Closed-union trace, read end to end, both attach and
delivery.

---

## Q2 — Does `agent.inject(...)` from an `agent/turn-stopping` listener reach the model on the next turn?

**Answer: YES — one step later, in the *same* turn. The loop re-reads the inbox
after the serial dispatch, and a non-empty `next-step` list cancels the break.**

The question's phrase "next turn" is the only thing to correct: the injection is
claimed by the next **step** of the current turn, which is a real request. That
is stronger than "next turn", not weaker.

### Where the message lands

| # | Fact | Citation |
|---|---|---|
| 1 | `inject` is `send(message, "next-step", false)` — the `false` is "do not wake the driver" | `dsh-agent-loop/lib/index.js:812-814` |
| 2 | `send` splices into the inbox and wakes only when asked | `dsh-agent-loop/lib/index.js:800-805` |
| 3 | For contrast: `followup` = next-turn + wake; `steer` = next-step + wake | `dsh-agent-loop/lib/index.js:806-811` |
| 4 | The inbox is a **durable session projection** (`key: "inbox"`, two lists) driven by `agent/inbox/spliced` events | `dsh-agent-loop/lib/index.js:21-62`, `:204`, `:1559` |
| 5 | The contract says exactly this: "Queue model-facing context for the next pre-step without waking the driver… idle drivers leave it pending until follow-up or steering wakes them" | `dsh-agent/lib/types/runtime-types.d.ts:202-209` |

### Why `turn-stopping`-time injection is caught

| # | Fact | Citation |
|---|---|---|
| 1 | `turn-stopping` fires **only while the turn's next-step list is empty** | `dsh-agent-loop/lib/index.js:998-1003` |
| 2 | Immediately after the awaited serial dispatch, the loop **re-reads the inbox**; a non-empty `next-step` skips the break and continues the same turn with `target = "next-step"` | `dsh-agent-loop/lib/index.js:1005-1006` |
| 3 | The next `preStep` claims the whole next-step batch | `dsh-agent-loop/lib/index.js:906`, `:103-108` |
| 4 | Claimed messages are appended as `user/message` before the request is built | `dsh-agent-loop/lib/index.js:1061` |
| 5 | The contract: the listener is "awaited before the boundary commits… the machine re-reads its inbox: fresh steering runs another step" | `dsh-agent/lib/types/runtime-types.d.ts:370-391` |

The contract names `steer` because `steer` is the documented objection API, but
the machine's re-read tests `inbox.nextStep.length`, not "was this steer?". An
injected message satisfies it identically. The only difference `steer` buys is
`wakeRequested = true`, which matters when the driver is **not** running — and
at `turn-stopping` the driver is by construction inside the running turn loop.

### If the session ends instead of continuing

| Case | Outcome | Citation |
|---|---|---|
| Cancelled or disposed | `cancel()` clears the inbox unless `keepInbox`; the removal is a durable splice with outcome `canceled` | `dsh-agent-loop/lib/index.js:815-820`, `:189-196` |
| Process exits, session never resumed | the message is a persisted session event and survives, but is never delivered | `dsh-agent-loop/lib/index.js:204` |
| Session resumed later | the projection restores the pending message; the next `followup`/`steer` wake claims it | `dsh-agent-loop/lib/index.js:175-177` |
| Injected while the driver is idle and nothing wakes it | stays pending indefinitely — `inject` never wakes | `dsh-agent/lib/types/runtime-types.d.ts:202-209` |

The last row is the real hazard for the plugin, and it does **not** apply at
`turn-stopping`. An injection from anywhere else (a timer, a tool body after the
turn closed, an async continuation that resolves late) may sit pending until
something else wakes the driver.

**Confidence: CERTAIN** for the code path and for in-turn delivery.
**UNRESOLVED, and immaterial:** nothing here proves a real provider echoes the
message back — that is the same live-session gap as
[22](22-context-injection.md) §7's "the injected text actually reaches the
model".

---

## Q3 — Does a throw in an `agent/created` listener fail session creation?

**Answer: YES. It rejects creation, and the loop then disposes the agent — the
agent is not left live and half-constructed.**

This confirms [14](14-decision-log.md) R11's assertion.

| # | Fact | Citation |
|---|---|---|
| 1 | `announce` awaits the serial `agent/created` dispatch; JSDoc: "a listener failure rejects" | `dsh-agent/lib/index.js:572-585` |
| 2 | cordis `serial` awaits each listener with no `try`/`catch` around the call — a rejection propagates | `cordis/lib/index.js:289-294` |
| 3 | The contract, verbatim: "A throw or rejection fails creation and skips later listeners" | `dsh-agent/lib/types/runtime-types.d.ts:214-227` |
| 4 | The loop awaits `announce` inside `publish()` | `dsh-agent-loop/lib/index.js:1745-1753` (call at `:1752`) |
| 5 | `publish()` is invoked inside `initializeAgent`'s callback | `dsh-agent-loop/lib/index.js:1888-1891` |
| 6 | `initializeAgent` catches, cancels the agent, rethrows; the outer catch `dispose()`s and rethrows | `dsh-agent-loop/lib/index.js:1900-1912` |
| 7 | `ctx.agents.create` delegates to the factory with no catch | `dsh-agent/lib/index.js:451-455` |
| 8 | The session controller's create path awaits it with no catch — the rejection reaches the caller | `dsh-api-session-controller/lib/index.js:449-458` |

So of the three options offered: **reject session creation**, not "logged and
swallowed" (that is `session/created`, an `emit`, per
[30](30-lifecycle-and-observability-surfaces.md) §1.1), and not
half-constructed.

### Two residues worth knowing

| Residue | Detail |
|---|---|
| `agent/disposed` fires for a creation that never completed | `announce` sets `entry.announced = true` **before** the dispatch (`dsh-agent/lib/index.js:576-577`) and only resets `announcing` in the `finally` (`:584-586`). The caller's `dispose()` detaches the entry, and `detachEntered` emits `agent/disposed` because `announced` is true (`dsh-agent/lib/index.js:538-544`, `:546-561`). A listener that books state in `agent/created` and releases it in `agent/disposed` is therefore safe; a listener that assumes "disposed implies created completed for all listeners" is not |
| Possibly stored session events | `setupAndPublish` flushes pre-publication events through the persistence handle **before** `publish` (`dsh-agent-loop/lib/index.js:1888-1891`). Whether a backend rolls that back when `agent/created` then rejects is backend-specific and **UNRESOLVED** — low stakes, and no bearing on the plugin's design |

**Confidence: CERTAIN** for the rejection and the disposal.
**UNRESOLVED:** the persistence residue above.

---

## Summary

| Question | Answer | Confidence | Spec edit implied |
|---|---|---|---|
| Q1 — can a pre-execute `deny` carry `additionalContexts` in-band? | **YES**, but only via a `tools/post-execute` listener over the denial; the `deny` decision itself has no such field, and `exec.deferContext()` from pre-execute is dropped on the deny path | CERTAIN | Flip [27](27-integration-surfaces.md):238 and [28](28-teaching-and-interaction-surfaces.md):527 to VERIFIED; promote the [28](28-teaching-and-interaction-surfaces.md) §5 "bonus finding" to a recommendation (it is the correction channel for the refused verb); fix the `dsh-tools/lib/index.js:1388` citation to `dsh-agent-loop/lib/index.js:572`; add the four traps to [26](26-preflight-and-error-taxonomy.md) Part B as a rule — *the guard returns `deny`, never throws, and never uses `deferContext`* |
| Q2 — does `agent.inject` at `turn-stopping` reach the model? | **YES** — claimed by the next step of the same turn; the loop re-reads the inbox after the serial dispatch. If the session is cancelled or disposed instead, `cancel()` clears the inbox and the message is durably discarded | CERTAIN (code path); UNRESOLVED (a live provider echo) | Flip [27](27-integration-surfaces.md):239 and [30](30-lifecycle-and-observability-surfaces.md):700 to VERIFIED; amend [30](30-lifecycle-and-observability-surfaces.md) §2.6 B.4 to say "delivered in the same turn, at the next step" rather than "next turn"; [22](22-context-injection.md) §4/§6's "do not use `agent.steer`" row can now name `inject` as a *verified-delivered* method, not merely a non-waking one |
| Q3 — does a throw in an `agent/created` listener fail session creation? | **YES** — the rejection propagates through `announce` → `publish` → `initializeAgent`, which cancels and disposes the agent; not swallowed, not half-constructed | CERTAIN | Confirm [14](14-decision-log.md) R11's second consequence and [30](30-lifecycle-and-observability-surfaces.md) §1.4's "no path that throws" as load-bearing, citing `dsh-agent/lib/index.js:572-585` + `dsh-agent/lib/types/runtime-types.d.ts:214-227`; add the `agent/disposed`-after-failed-`agent/created` ordering to [30](30-lifecycle-and-observability-surfaces.md) §1's verification table |

All three belong in [11](11-verified-dsh-api-contract.md) §9 as VERIFIED rows.
