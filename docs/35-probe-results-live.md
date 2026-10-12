# 35 — Probe results: live session

**What was run.** The throwaway probe from [34](34-probe-plan.md) §2 was built
at `probe/`, installed into the live `web` profile with `plugin_manager`
`install_bundle` (result: `application: applied`, `changed: true`, no warnings),
exercised with four sentinel commands, then **removed** (`remove_bundle`,
`application: applied`). The profile is verified clean afterwards: no probe entry
in `dependencies`, none in `dsh.profile.bundles`, none in `node_modules`.

The probe logged JSONL to `/tmp/dsh-jujutsu-probe.jsonl` — **383 records** —
and the harness's own session logs were used to confirm _delivery_, because a
probe that only logs what it sent cannot tell you what the model received.

## What the live run settles

| #       | Question                                                                | Result        |
| ------- | ----------------------------------------------------------------------- | ------------- |
| **Q1**  | Does `{kind:'ask'}` reach a UI and return `allowed-once`?               | **CONFIRMED** |
| **Q3**  | Does a `deny` plus a post-execute `additionalContexts` reach the model? | **CONFIRMED** |
| **Q2**  | Does `agent.inject` at `agent/turn-stopping` reach the model?           | **CONFIRMED** |
| control | Does a host plugin's `ctx.systemPrompt.context` reach the model?        | **CONFIRMED** |
| —       | Is the deny text delivered verbatim?                                    | **CONFIRMED** |

### Q1 — the ask path works end to end

```
pre-execute        cmd: "echo PROBE_ASK"
pre-execute/ask                       ← the listener returned {kind:'ask'}
post-execute       isError: false     ← the call proceeded
```

and the tool result was `PROBE_ASK` — the command **ran**. So
`{kind:'ask'}` → approval → `allowed-once` → allow is a working chain. The
gating design in [17](17-bypass-and-approval.md) rests on this, and it holds.

### Q3 — the denial's second channel is real

```
pre-execute        cmd: "echo PROBE_DENY_CTX"
pre-execute/deny-ctx
post-execute       isError: true
post-execute/attaching-context        ← our listener returned {kind:'accept', additionalContexts}
```

The tool result was `Error: PROBE_DENY_CTX_REASON` — the command did not run —
and in this session's durable log the attached token appears as an
**`agent/inbox/spliced`** record. That is the delivery mechanism: the denial
carries a terse error line, and the explanation rides beside it into the same
next request.

This confirms the two-channel design in `SPEC.md` §5.2 as more than a code
reading.

### Q2 — `inject` at end-of-turn lands

```
turn-stopping/injected   {"turn": 24, "key": "session-dc980960-…"}
```

and in **that** session's durable log, `PROBE_INJECT_TOKEN` appears as an
`agent/inbox/spliced` record. So `agent.inject` from `agent/turn-stopping`
reaches the model's inbox — the mechanism [27](27-integration-surfaces.md) §1
proposed for the one actionable per-session alert.

### The control — and why it mattered

`ctx.systemPrompt.context` produced a **`user/message`** record in the session
log, exactly as its own documentation says ("dynamic model context materialized
as a durable user-role snapshot"). The token was also visible in the live
runtime context, and disappeared the moment the bundle was removed — a clean
confirmation that removal is effective.

### Deny is verbatim

`echo PROBE_DENY` → the tool result was exactly `Error: PROBE_DENY_REASON`. No
prefix, no wrapper, no truncation. The 240-character budget in
[25](25-prompt-copy.md) is the real constraint, and nothing else is added.

### The plugin can reach everything it needs

`apply` logged `hasSystemPrompt, hasFs, hasApproval, hasSkills, hasCommands,
hasUserQuestions` — **all true**. Every surface [27](27-integration-surfaces.md)
proposed is available to a host plugin in this profile.

## An accidental finding worth keeping

The probe's sentinel match is a naive `cmd.includes('PROBE_DENY_CTX')`. While
inspecting its own log, the parent ran a `grep` whose _pattern text_ contained
that string — and **the probe denied the grep**.

That is a live demonstration of the false-positive class
[21](21-guard-evasion.md) predicted: a guard that scans command text for a token
denies commands that merely _mention_ the token. It is the strongest argument
yet for the rule in [15](15-verb-mapping.md) §4 — **resolve the invoked program,
never scan for a token** — and it happened to the person writing the rule.

## What the run did NOT settle

| #       | Question                                                                                 | Why not                                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q12** | Preflight latency at session start                                                       | `agent/created` never fired: the probe mounted **mid-session**, and that event only fires for new agents. Needs a session started with the probe already installed.                                                                                             |
| **Q13** | Does `ctx.fs.stat(<cwd>/.jj)` at `agent/created` see the same root a tool call computes? | same reason                                                                                                                                                                                                                                                     |
| —       | The outgoing message list                                                                | the `agent/request` inspector logged `messageCount: 0` on all 79 records: `config.messages` is not where the messages live in `LlmCallConfig`. The delivery questions were answered from the session logs instead, which is the more trustworthy source anyway. |

Both are cheap to close with a second run — install, start a **new** session in
a `jj` fixture, read the log — but neither is load-bearing: preflight can stay
lazy on first `jj` touch, which is the current behaviour.

## Cost of the run, and why it was removed promptly

The bundle is **profile-wide**: it fired on every session in the profile, and
the log shows activity from five unrelated workspaces. 383 records accumulated
in ~25 minutes. That is inherent to installing a host plugin into a live
profile, and it is why [34](34-probe-plan.md) §2 insisted on one package and a
prompt removal.

Cleanup performed:

- `plugin_manager remove_bundle` → `application: applied`.
- One **stale symlink** left in the profile's `node_modules`
  (`dsh-jujutsu-probe → ../../../../dev/dsh-jujutsu/probe`), which `pnpm` did
  not prune; removed by hand. It was inert — nothing referenced it once the
  bundle list was updated — but a dangling link into the workspace is not
  something to leave in a profile.
- The log at `/tmp/dsh-jujutsu-probe.jsonl` is **retained** as the evidence
  behind this document.
- `probe/` remains in the workspace and is gitignored. It is the instrument, not
  a product, and it must never be shipped.
