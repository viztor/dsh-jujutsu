# 34 — The probe plan: what is needed to close the remaining unknowns

**Status:** the plan, not the results. Three items are already closed this
session ([33](33-probe-results-jj.md)) and six more are being closed by source
reading ([31](31-probe-results-pipeline.md), [32](32-probe-results-teaching.md)).
What is left needs **one throwaway plugin and one session**.

## 1. What is still open, and what settles it

| # | Question | Settled by | Blocked on |
|---|---|---|---|
| **Q1** | Does `{kind:'ask'}` reach a UI and return `allowed-once`? | **closed — run live** ([35](35-probe-results-live.md)) | — |
| **Q2** | Does `agent.inject` at `agent/turn-stopping` reach the model? | **closed — run live** ([35](35-probe-results-live.md)) | — |
| **Q3** | Can a `deny` carry `additionalContexts` in-band? | **closed — source trace + run live** | — |
| **Q4** | The token delta between the injected prose and a skill catalog line | **closed** — [32](32-probe-results-teaching.md) §Q3 | — |
| **Q5** | Is a runtime-registered skill visible to a preset-scoped agent? | **closed** — [32](32-probe-results-teaching.md) §Q1 | — |
| **Q6** | Does a plugin-supplied `wait:{callId}` render a client card? | **closed (code path)** — [32](32-probe-results-teaching.md) §Q4 | not GUI-probed |
| **Q7** | Does a host-plane `ask()` reach a preset-scoped answerer? | **closed** — [32](32-probe-results-teaching.md) §Q5 | — |
| **Q8** | Does compaction drop the skill catalog message? | **closed** — [32](32-probe-results-teaching.md) §Q2 | — |
| **Q9** | `jj-hunk` version when unreadable | **closed** — [33](33-probe-results-jj.md) §1 | — |
| **Q10** | `JJ_CONFLICTS_PRESENT` on `jj_new` | **closed** — [33](33-probe-results-jj.md) §2 | — |
| **Q11** | Identity: which commands mint an unpushable commit | **closed** — [33](33-probe-results-jj.md) §3 | — |
| **Q12** | Preflight latency at session start | **not run** — the probe mounted mid-session, so `agent/created` never fired | a second run, started fresh |
| **Q13** | Does `ctx.fs.stat` at `agent/created` see the same root a tool call computes? | **not run** — same reason | a second run, started fresh |
| **Q14** | `jj_hunk_apply(mode:'squash')` author behaviour | a `jj` case that actually moves a hunk | nothing |

**Twelve of fourteen are closed.** Q12 and Q13 are the only ones left, both
trivially closeable and neither load-bearing.

Only **five** questions need a plugin. Everything else is source or `jj`.

## 2. The probe plugin

One package, one file, throwaway. It is deliberately **not** the real plugin:
it uses `node:fs` for logging (which the real plugin must never do) and it
implements no product behaviour.

### Registration

| # | Seam | Behaviour | Answers |
|---|---|---|---|
| 1 | `tools/pre-execute` | dispatch on a sentinel in the command text | Q1, Q3 |
| 2 | `agent/created` | timestamp; `ctx.fs.stat(<cwd>/.jj)`; log the result | Q12, Q13 |
| 3 | `agent/turn-stopping` | `agent.inject()` a unique token | Q2 |
| 4 | `agent/request` | log the outgoing message list — the observability backbone | Q1, Q2, Q3, Q5 |
| 5 | `systemPrompt.context` | return a unique token; a control for "did injection reach the model at all" | sanity |
| 6 | `ctx.skills.register()` | register a `probe-skill` | Q5 |
| 7 | `ctx.commands.register()` | register `/probe` | command reachability |

### The sentinels (seam 1)

| Command | Listener returns | What it proves |
|---|---|---|
| `echo PROBE_PASS` | `next()` | the listener ran and did not interfere |
| `echo PROBE_ASK` | `{kind:'ask', reason:'PROBE_ASK_REASON', displayReason:{en:'PROBE_ASK_DISPLAY'}}` | **Q1** — a prompt appears; on approve the command runs; on reject, what the model actually sees |
| `echo PROBE_DENY` | `{kind:'deny', reason:'PROBE_DENY_REASON'}` | the reason reaches the model verbatim as `Error: …` |
| `echo PROBE_DENY_CTX` | deny, then attempt `additionalContexts` on the post-execute path | **Q3** — whether extra context survives a denial |

### Logging

Append one JSONL record per observation to the path in
`$DSH_JUJUTSU_PROBE_LOG`, with a monotonic timestamp, the seam name, and a
payload. `agent/request` is the important one: it records the outgoing message
list, so a token injected at `turn-stopping` or attached to a denial is visible
as *present* or *absent* in the next request rather than inferred.

### Cleanup

The probe must be **removed** afterwards — `plugin_manager remove_bundle`. It
is installed into the live `web` profile and affects every session until then.
That is the real cost of this probe, and the reason it is one package rather
than several.

## 3. Scenarios

Run in one chat session, in `/tmp/dsh-jujutsu-fixtures/jj-colocated` (already
built by `test/fixtures/build-fixtures.sh`).

| # | Action | Observe |
|---|---|---|
| S1 | `echo PROBE_PASS` | one listener record; the command ran |
| S2 | `echo PROBE_ASK`, **approve** | a prompt appeared with `PROBE_ASK_DISPLAY`; the command ran; `allowed-once` |
| S3 | `echo PROBE_ASK`, **reject** | what the model saw — ours or *"the user rejected tool bash"* ([17](17-bypass-and-approval.md) §The trap) |
| S4 | `echo PROBE_DENY` | the model reads `Error: PROBE_DENY_REASON` |
| S5 | `echo PROBE_DENY_CTX` | whether the extra context appears in the next `agent/request` |
| S6 | end the turn, then send one more message | whether the `turn-stopping` token appears in the next request |
| S7 | `list the skills you can see` | whether `probe-skill` is in the catalog |
| S8 | read the log | `agent/created` timing, and whether the `.jj` stat matched the tool-call root |

## 4. What is needed to run it

1. **Permission to install one bundle into the `web` profile**, and to remove it
   afterwards. `plugin_manager` needs approval; the install affects every
   session in the profile while it is present.
2. **One session** in a `jj` fixture. No model behaviour is being tested — the
   probes are all harness mechanics, so the conversation can be trivial.
3. Nothing else. The fixtures, the `jj` toolchain, and the source are all in
   place.

**If that permission is not available**, the fallback is the analytical path:
source reading settles Q3–Q8 (in flight), and Q1, Q2, Q12, Q13 stay
**UNVERIFIED** — which is survivable, because the design has already been shaped
so that none of them is load-bearing:

- Q1: the guard returns `deny` under `never` and `ask` otherwise; if `ask`
  misbehaves, the deny path is unaffected.
- Q2: the end-of-turn advisory is already reduced to a single optional alert.
- Q12/Q13: preflight can stay lazy on first `jj` touch, which is the current
  behaviour.

So the probe is **worth doing but not blocking**. That is the honest
assessment: it would convert four assumptions into facts, and none of them
would change the v0.1 shape.

## 5. What each outcome would change

| If the probe shows… | Then |
|---|---|
| `ask` never reaches a UI | drop `bypass: 'ask'` as a default; the D2 bypass becomes config-only, and the `deny` path carries everything |
| a rejection loses our reason | already assumed and documented — no change; it confirms [17](17-bypass-and-approval.md) §Step 6b |
| `deny` **can** carry `additionalContexts` | the guard can split its message: a short `reason` for the error line and the full `jj` guidance as context. **The most useful possible outcome** — and it is **confirmed**, see §7 |
| `agent.inject` at `turn-stopping` does not reach the next turn | drop G8 entirely; the broken-repo alert moves to `systemPrompt.context` |
| the skill catalog is invisible under a preset | the skill split is dead; the manual stays in the prompt and the ~5× saving is lost |
| `.jj` stat at `agent/created` mismatches the tool-call root | preflight stays lazy; R11 reverts to the lazy trigger |

## 6. Order

1. Wait for the two source-reading results — they may close six items for free.
2. Run the probe if permission is granted, otherwise record the four as
   permanently UNVERIFIED with the reasoning above.
3. Resolve Q14 with a `jj` case that actually moves a hunk.
4. Only then build the real plugin: the M0 spike in
   [24](24-implementation-plan.md) §4 is a subset of this probe, so the probe
   *is* M0.

## 7. Q3 closed by source trace — a denial has two channels

Settled without a probe, and it is the outcome that changes the design.

A `deny` returns `{kind:'post-result'}` into `finalizeScheduledExecution`
(`dsh-tools/lib/index.js:3125`), which **always** calls `postExecute`
(`:3368`) — there is no error branch that skips it. `postExecute` (`:3503`) then
merges a listener's `additionalContexts` onto that already-denied result:

```js
const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
return this.markCanonical(exec, { ...result, ...additionalContexts.length > 0 ? { additionalContexts } : {} });
```

So the guard's denial carries **two** channels: the terse `reason` that becomes
the error line, and a longer explanation attached from `tools/post-execute`.
Constraints, both from the same code: return `{kind:'accept', additionalContexts}`
with **no `value`** (the `value` branch throws on an error result, `:3519`), and
prefer `accept` over `block` so our `reason` text survives.

Full trace and the design change: [`SPEC.md` §5.2](../SPEC.md).
