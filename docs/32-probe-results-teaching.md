# 32 — Probe results: the teaching surface

**What this is.** Five questions left **UNVERIFIED** by
[28](28-teaching-and-interaction-surfaces.md), settled from source against DSH
`0.2.0-rc.2`. Nothing here was executed; every answer is a code path or an
arithmetic, and anything I could not close is labelled.

**Headline.** The skill split survives — but not for the reason
[28 §1.5](28-teaching-and-interaction-surfaces.md) gives. Q1 and Q5 confirm it;
Q2 does not kill it but does invalidate its "once per session" cost model; Q3
shows the token saving is **≈26 tokens/request, not 5×**, and turns _negative_
if the catalog description is written as long as 28 proposes.

Citations are package-relative. `dsh-web-app/cordis.patch.yml` etc. are the
installed composition rows, not the source tree.

---

## 0. Answers at a glance

| Q      | Answer                                                                                                                                                                                                                                                             | Confidence                                                                   | Effect on the spec                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Q1** | Yes. A global runtime skill is merged into every preset-scoped agent's catalog; the preset layer only _shadows_ a same-name entry.                                                                                                                                 | CERTAIN                                                                      | §5.9 confirmed. Add: a preset that mounts no `tool-skill` has no catalog at all.                             |
| **Q2** | Not protected — it is a plain surface node inside any compacted span. But it is **self-healing**: the next `agent/pre-step` republishes it as a catalog _update_. Pressure compaction republishes in the same step; overflow compaction loses exactly one request. | CERTAIN                                                                      | §5.9's "once per session" is false. Cost must be modelled as "one line, republished after every compaction". |
| **Q3** | Real injection is **89 words / 553 chars ≈ 138 tok**, not ~200 words. 38 of the 89 words are MANUAL and can move (≈57 tok saved). The catalog line costs 30–77 tok. Net **−26 tok** with a short description, **+20 tok** with 28's 40-word description.           | CERTAIN                                                                      | Kill the "roughly 5×" claim. Justify the split by depth, not tokens; cap the description at ~35 words.       |
| **Q4** | Yes — a plugin `ask()` enters the _same_ answerer waterfall; `wait:{callId}` keys the _same_ card. No plugin-specific path exists.                                                                                                                                 | LIKELY (code path complete and shared with the tool; not exercised in a GUI) | Unblocks [28 §3.5(b)](28-teaching-and-interaction-surfaces.md) hunk-selection confirmation.                  |
| **Q5** | "Owned" = created through another agent's context (a subagent). Preset scoping is irrelevant. A root agent under any preset is served.                                                                                                                             | CERTAIN                                                                      | §5.11's install offer works in preset sessions; only a subagent-context offer fails.                         |

---

## Q1 — Is a runtime-registered skill visible in the catalog for a preset-scoped agent?

**Answer: yes.** The registry is host-plane and _layered_; a read always merges
the global layer with the viewing agent's scope chain, and the chain can only
shadow, never hide.

**The registration lands in the global layer.** `register()` files into the
layer of the calling context's scope:

```js
// dsh-skill/lib/index.js:195
const scope = scopeOf(this.ctx);
```

A repository plugin mounted as a host-plane row has no scope tag, so `scopeOf`
returns `undefined` and the entry goes to `layers.global`. That is the deployment
shape the composition documents: _"deployment-level providers — repository
plugins, a host skill-filesystem row — register into its global layer"_
(`dsh-web-app/cordis.patch.yml:475-479`).

**The read merges global first, then the chain.** The tool's lookup passes the
agent as the viewing scope:

```js
// dsh-tool-skill/lib/index.js:207-211
const snapshot =
  ctx.tools.get(skillTool.name, agent) === skillTool
    ? await ctx.skills.snapshot({
        cwd: agent.session.header.cwd,
        signal,
        scope: agent,
      })
    : { skills: [], complete: true };
```

```js
// dsh-skill/lib/index.js:298-306
async collectFresh(options) {
    const layers = [this.layers.global, ...this.layers.chainLayers(options.scope)];
    const merged = new Map();
    ...
    for (const layer of layers) { ...; for (const entry of collected.entries) merged.set(entry.candidate.name, entry); }
```

`chainLayers` returns "farthest ancestor first and the exact scope last"
(`dsh-scope/lib/index.js:155-168`), so the merge order is
**global → preset layer → agent layer**, nearest wins a duplicate name. Global
entries are unconditionally present; they are lost only to a same-name entry in
a nearer layer.

**The agent _is_ the scope key, and the preset is its parent.** The agent loop
mints the scope with the agent as the key, and the preset registry parents that
key to the preset's own key:

```js
// dsh-agent-loop/lib/index.js:778
this.scope = createScope(loopCtx, this);
```

```js
// dsh-agent-preset-registry/lib/index.js:675-678  (join)
const binding = {
  parent: bindScopeParent(key, generation.key),
  generation,
};
```

The preset's rows mount under `createScope(this.owner, key)`'s context
(`dsh-agent-preset-registry/lib/index.js:527,534`), which is why a preset's
`skill-filesystem` registers into _that preset's_ layer — exactly what the
composition says, verbatim:

> `# The `skill`REGISTRY stays in the host plane. … a preset's`skill-filesystem` registers into that preset's layer, and each agent reads the merged catalog its scope chain selects.`

(`dsh-web-app/cordis.patch.yml:475-482`.) The standard preset proves the pairing:
it mounts `skill-filesystem` + `tool-skill` inside the preset
(`dsh-web-app/presets/standard.patch.yml:34-37`) while the host rows are
disabled (`dsh-web-app/cordis.patch.yml:484-488`).

**Two caveats worth writing down.**

1. The catalog is emitted **only if the agent resolves this exact tool**:
   `ctx.tools.get(skillTool.name, agent) === skillTool` (`dsh-tool-skill/lib/index.js:207`).
   A preset with no `tool-skill` row (`presets/minimal.patch.yml` has none) has
   no catalog, so the skill is invisible there — as is every other skill.
2. A same-name skill in the preset or project layer **wins** the merge. That is
   the right default (a repo can override `jujutsu`) but it means the plugin
   cannot guarantee the body the model loads is ours.

**Confidence: CERTAIN.** The merge is unconditional in code; no runtime probe is
needed. The only unexercised link is a live registration, which cannot change
the merge order.

**What it changes.** §5.9's registration plan is sound as written. Add one
sentence: _the catalog exists only under a preset that mounts `tool-skill`_, and
keep the existing note that a project skill of the same name wins.

---

## Q2 — Does compaction shadow or drop the skill catalog message?

**Answer: it shadows it — the catalog is not protected — but the catalog is
self-healing and republishes itself at the next pre-step.** The one window where
the model sees no catalog is the retry immediately after a context-overflow
compaction.

**The catalog is an ordinary surface node.** The pre-step decision's messages are
appended as durable `user/message` events with no protection flag:

```js
// dsh-agent-loop/lib/index.js:1061
if (firstAttempt)
  for (const message of decision.messages)
    this.session.append("user/message", message, { surfaceOp: "append" });
```

**Compaction starts at surface node 1, so the catalog is always inside the
range.** The only protected node is a `system/message` at position 0:

```js
// dsh-compaction-basic/lib/index.js:415
const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
```

The catalog is published at the first pre-step, so it sits at (or within one
node of) position 1 — inside any span that compaction selects. The replacement
is a surface op, not a log deletion:

```js
// dsh-compaction-basic/lib/index.js:651-654
surfaceOp: {
    op: "replace",
    startSeq: start,
    endSeq: end
},
```

Shadowed events stay readable in the append-only log — the compaction code
itself reads them back (`prepareCompaction` → `buildSummarizationInput` over
`shadowedSeqs`).

**The republish is digest-gated on the _log_, not the surface.** `catalogHistory`
scans the whole log but only treats a catalog as "visible" when its seq is still
a surface node:

```js
// dsh-tool-skill/lib/index.js:331-347
function catalogHistory(agent) {
    const visible = new Set(agent.session.surface.nodes);
    let published = false;
    for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
        ...
        published = true;
        if (visible.has(event.seq)) return { visibleDigest: digest, published };
    }
    return { published };
}
```

So after compaction: `visibleDigest === undefined` (the branch at
`dsh-tool-skill/lib/index.js:222` cannot match), `published === true`, and

```js
// dsh-tool-skill/lib/index.js:231
const catalog = history.published ? renderCatalogUpdate(entries) : renderCatalogMessage(entries);
```

`renderCatalogUpdate` re-lists **every** skill under "This complete catalog
replaces every earlier available-skills list in this session"
(`dsh-tool-skill/lib/index.js:262-291`).

**Timing: the pressure path loses nothing.** Automatic pressure compaction runs
_inside_ `agent/pre-step` (`dsh-compaction-basic/lib/index.js:839-853`), and the
catalog publisher reads the surface only after its own `await next()`
(`dsh-tool-skill/lib/index.js:203-206`). Whichever of the two listeners is
upstream, the publisher observes the post-compaction surface and appends the
update in the same decision — before the model request. (In the standard preset
`tool-skill` is mounted before the compaction group —
`dsh-web-app/presets/standard.patch.yml:36-37,70-71` — so the publisher is
upstream and compaction runs inside its `next()`.)

**Timing: the overflow path loses exactly one request.** Context-overflow
compaction runs in `agent/request-error` (`dsh-compaction-basic/lib/index.js:861`),
which the step loop handles with a bare `continue`:

```js
// dsh-agent-loop/lib/index.js:1133
if (action?.kind !== "retry") throw new LlmError(...);
continue;
```

That `continue` retries the request **without re-running `agent/pre-step`**
(pre-step runs once per step, at `dsh-agent-loop/lib/index.js:954`), and
`firstAttempt` is already false so nothing is re-appended. The retried request
therefore goes out with the catalog shadowed. The next step's pre-step
republishes it.

**Also worth knowing:** the catalog _framing_ (`<system-reminder>` + the two
closing paragraphs, `dsh-tool-skill/lib/index.js:238-260`) is ~171 tokens and is
paid whenever any model-invocable skill exists — it is harness overhead, not
ours. Our marginal cost is the single entry line.

**Confidence: CERTAIN** for "not protected" and for "republished at the next
pre-step"; **CERTAIN** for the same-step republish on the pressure path (the
argument is order-independent); **LIKELY** for the exact count of requests lost
on the overflow path (derived from the `continue`, not executed).

**What it changes.** §5.9 and [22](22-context-injection.md) §6 must stop saying
the catalog is "published once per session". The correct statement: _one line,
durable, and republished as a full replacement catalog after any compaction that
shadows it._ Two consequences for the spec: (a) the line is **not** a one-time
cost; (b) a compaction in a skill-heavy session re-pays the whole catalog at
least once, which is a harness-wide effect our registration triggers by changing
the digest. Neither is a reason to abandon the split — the manual would have
been shadowed too, and a re-published catalog is strictly better than a lost one.

---

## Q3 — The real token delta

### 3.1 The shipped text, measured

The real injected text is [25 §1](25-prompt-copy.md), not the ~200-word budget.
Counted on the doc's own strings (line wraps joined with single spaces; the
runtime context is the _rendered_ §1.3 form, which is what ships).

| Component                       | Words  | Chars   | ≈ tokens (chars ÷ 4) |
| ------------------------------- | ------ | ------- | -------------------- |
| System section, §1.1            | 68     | 397     | 99.3                 |
| Runtime context, rendered, §1.3 | 21     | 155     | 38.8                 |
| **Combined, as shipped**        | **89** | **553** | **≈ 138**            |

The template form of the context (each `{{…}}` group as one word) is 12 words;
the rendered form is 21. The rendered form is the one the model pays for.

### 3.2 Classification — what can move

Each sentence of §1.1, plus the context block:

| #   | Sentence                                                                                      | Class                    | Words  | Chars | ≈ tok |
| --- | --------------------------------------------------------------------------------------------- | ------------------------ | ------ | ----- | ----- |
| S1  | Version control here is Jujutsu (jj).                                                         | STATE (constant premise) | 6      | 37    | 9.3   |
| S2  | The bash tool intercepts git and returns the jj command to run instead; there is no Git mode. | **RULE**                 | 18     | 93    | 23.3  |
| S3  | Use jj for every version-control step.                                                        | **RULE**                 | 6      | 38    | 9.5   |
| S4  | The working copy @ is always a commit and always dirty: no staging, nothing to add.           | MANUAL                   | 16     | 83    | 20.8  |
| S5  | Address revisions by change ID, which survives rewrites; commit IDs do not.                   | MANUAL                   | 12     | 75    | 18.8  |
| S6  | Bookmarks are the publish boundary: jj git push --bookmark `<name>`.                          | MANUAL                   | 10     | 66    | 16.5  |
| —   | Runtime context: root / layout / `@` / `jj-hunk`                                              | STATE                    | 21     | 155   | 38.8  |
|     | **RULE total**                                                                                |                          | **24** | 131   | 32.8  |
|     | **STATE total**                                                                               |                          | **27** | 192   | 48.0  |
|     | **MANUAL total**                                                                              |                          | **38** | 224   | 56.0  |

**38 of the 89 words (43%) can move.** The RULE is 24 words and cannot: it has
to be true before the first Git command, and a skill loads only after the model
decides it needs one. The STATE is 27 words and cannot: it is the workspace.

Every MANUAL sentence is already carried by a tool description —
`jj_status`/`jj_diff` carry S4 ([25 §3](25-prompt-copy.md)), `jj_log` carries S5,
`jj_bookmark` carries S6 — so moving them loses nothing that is not loaded with
the tools anyway.

### 3.3 Before / after

Whole-block char counts (they include the separators, so they are the honest
totals):

|                                                        | Words | Chars | ≈ tok            |
| ------------------------------------------------------ | ----- | ----- | ---------------- |
| **Before** — section + rendered context                | 89    | 553   | **138.3**        |
| **After** — RULE + STATE only                          | 51    | 326   | **81.5**         |
| Saving (the moved MANUAL)                              | 38    | 227   | **56.8**         |
| Added — catalog line, 18-word description              | 18    | 122   | 30.5             |
| Added — catalog line, 51-word description (28's shape) | 51    | 308   | 77.0             |
| **Net, short description**                             |       |       | **−26.3 (−19%)** |
| **Net, 28's routing description**                      |       |       | **+20.3 (+15%)** |

Catalog line = ``- `jujutsu`:`` (13 chars) + the description, truncated at 500
chars (`dsh-tool-skill/lib/index.js:293-295, 359-362`).

**Break-even: the description may be at most 227 − 13 = 214 chars ≈ 35 words.**
Above that the split costs more than the manual it removed.

Two further asymmetries the "5×" claim hides:

- **The line is not one-time.** It is a durable user message, so it is re-sent
  with every request — exactly like the section it replaced (Q2).
- **A session that loads the skill pays more than it saved.** Once loaded the
  body is durable and unbounded. The split wins only in sessions that never load
  it, and only by ~26 tok/request.

**Confidence: CERTAIN.** This is arithmetic on the shipped strings.

**What it changes.** Replace the "roughly 5×" language in
[28 §1.5](28-teaching-and-interaction-surfaces.md), [22 §6](22-context-injection.md)
and `SPEC.md` §5.9 with the measured figures. The split is still worth doing, but
its justification changes: **the skill is a depth play, not a token play.** The
prompt budget caps the manual at 38 words; the skill body can be 5–10× longer —
op log, change IDs, the conflict model, the verb table — and cost nothing in the
sessions that never need it. That is the win. Write the description as a routing
rule under ~35 words (`...when a Git command is refused, when the user says
"commit", "branch", "rebase", or "undo"...`) and no longer.

---

## Q4 — Does a plugin-supplied `wait: {callId}` render a client card?

**Answer: yes — the plugin path and the tool path are the same path.** There is
no separate rendering route for a plugin; the only variable is `wait.callId`.

The tool does nothing a plugin cannot:

```js
// dsh-tool-ask-user/lib/index.js:195-198
return answerResult(
  await ctx.userQuestions.ask({
    ...request,
    wait: { callId: exec.callId },
  }),
);
```

`ask()` dispatches the scoped answerer waterfall
(`dsh-user-questions/lib/index.js:668-690`), which the API bridge forwards to the
client as a declared remote waterfall event:

```js
// dsh-api-remotes/lib/index.js:122-125
{ event: "user-questions/request", mode: "waterfall" }
```

The client answerer keys the card **by `request.wait.callId`**:

```js
// dsh-client-ui-user-questions/lib/client.js:1757-1761
async function answerQuestion(ctx, owner, request, next, cards) {
    const sessionId = ctx.sessions.scopeOf(owner);
    if (sessionId === void 0) return next();
    const callId = request.wait?.callId;
    const card = cards.ensure(sessionId, request.questions, callId);
```

`ensure` returns the existing card for that `(session, callId)` or creates and
publishes one into the composer seat via the pending-interaction registry
(`dsh-client-ui-user-questions/lib/client.js:1672-1678, 1900`). Same card, same
options, same `custom` free text, same `multiSelect`.

**The one constraint: pass a real `exec.callId` from inside a tool body.** With a
callId the card's dismissal is `"hide"` and it stays answerable from its tool-call
row (`dsh-client-ui-user-questions/lib/client.js:188, 1720-1730`), and that row is
what re-reveals a hidden panel:

```js
// dsh-client-ui-tool/lib/client.js:2349
revealPanel: (callId) => ctx.get("userQuestionPanels")?.reveal(sessionId, callId) ?? false,
```

A fabricated id would create a card with no row to reveal it from — the panel
hides and the request waits for its abort. So the rule is: **a plugin may ask,
but only from inside a tool call, and with that call's id.** Without a callId the
card is still rendered while pending, but it is unnamed and removed on
settlement (`dsh-client-ui-user-questions/lib/client.js:1809`).

**Confidence: LIKELY.** The card-creation path is CERTAIN from source and is the
same code the working tool uses; what I did not do is mount a probe and look at
the GUI. What would settle it: call `ctx.userQuestions.ask({agent: exec.agent,
wait: {callId: exec.callId}, questions: [...]})` from a tool body and confirm the
panel renders and the answer returns.

**What it changes.** [28 §3.5(b)](28-teaching-and-interaction-surfaces.md)'s
first blocker is removed. Hunk-selection confirmation may use the structured
question channel with `multiSelect`, from a tool body, keyed by `exec.callId`.
The second blocker (`DELEGATED_CALLER` for subagents) stands — see Q5.

---

## Q5 — Does a host-plane `ask()` reach a preset-scoped answerer?

**Answer: yes, for any root agent, preset or not.** "Owned" has nothing to do
with presets.

The gate is two checks, both about the _runtime_ agent graph:

```js
// dsh-user-questions/lib/index.js:531-535
assertLiveRoot(agent) {
    const agents = this.ctx.get("agents");
    if (agents === void 0 || agents.get(agent.id) !== agent) throw new UserQuestionError("...", "CALLER_NOT_LIVE");
    if (!agents.roots().includes(agent)) throw new UserQuestionError("human interaction is unavailable while the calling agent is owned by another live agent; ...", "DELEGATED_CALLER");
}
```

and "owned" is defined as _created through another agent's context_:

```js
// dsh-agent/lib/index.js:621-623
roots() {
    return [...this.store.values()].filter((entry) => entry.owner === void 0).map((entry) => entry.agent);
}
```

A preset-scoped root agent is created by the session controller
(`presets.mount(agentCtx, resolvedId)` →
`dsh-api-session-controller/lib/index.js:358-368`), not by a parent agent, so
`entry.owner === undefined`, it is in `roots()`, and the gate passes. Only a
subagent — `dsh-subagent`/`dsh-tool-subagent` children — fails.

**The dispatch is from the service's own context, not the caller's**, which is
why a host-plane plugin is not disadvantaged:

```js
// dsh-user-questions/lib/index.js:681
return await(
  agent === void 0
    ? this.ctx.waterfall("user-questions/request", request, noAnswerer)
    : this.ctx.waterfall(
        scopeTarget(agent, agent),
        "user-questions/request",
        { ...request, agent },
        noAnswerer,
      ),
);
```

The bridge listener is untagged, so `scopeTarget` admits it, and it recovers the
agent from the carrier rather than from the caller:

```js
// dsh-api-remotes/lib/index.js:147-153
return ctx.on(event, (function(request, next) {
    const carrierAgent = carrierKeyOf(this);
    if (carrierAgent === void 0) return next();
    const agent = request.agent;
    if (agent === void 0 || agent !== carrierAgent) throw new TypeError(`forwarded scoped event ... must carry its Agent directly`);
```

**There is exactly one answerer, and it is the client.** `user-questions` is a
host row (`dsh-base/cordis.patch.yml:71-72`), and the only registered
`user-questions/request` listener in the tree is
`dsh-client-ui-user-questions/lib/client.js:1927`. There is no preset-scoped
answerer to miss. Consequences: the plugin **must** pass `agent` (without it
`carrierKeyOf(this)` is `undefined`, the bridge drops the event, and `ask()`
throws `NO_PROVIDER`), and a headless host with no client attached also gets
`NO_PROVIDER`.

**Confidence: CERTAIN** for the gate and dispatch semantics (complete code path);
**LIKELY** for the end-to-end answer arriving (same reasoning as Q4).

**What it changes.** [28 §3.5(a)](28-teaching-and-interaction-surfaces.md)'s
`jj-hunk` install offer works as specified in a preset session. Keep the
`NO_PROVIDER` catch, and add one more: if `jj_hunk_list` is ever executed inside
a subagent, `ask()` throws `DELEGATED_CALLER` and the handler must fall back to
the "return the command" branch. Also make `agent` a required argument in the
spec's call shape — omitting it silently degrades to `NO_PROVIDER`.

---

## Verdict

**The split survives — but the reason given for it does not.** Q1 confirms the
mechanics outright: a host-plane `ctx.skills.register()` lands in the global
layer and every preset-scoped agent merges it, with the preset able only to
shadow a same-name entry — so `SPEC.md` §5.9's registration plan is correct as
written. Q2 does not kill the split: the catalog is _not_ protected from
compaction, but `catalogHistory` reads the append-only log rather than the
surface, so a shadowed catalog is republished as an update at the next
`agent/pre-step`; pressure compaction republishes it in the same step, and only
the context-overflow retry leaves one request without it — a bounded, transient
loss that the old in-prompt manual would not have suffered but that is far better
than losing the manual outright. Q5 confirms the interactive half: "owned" means
a subagent, not a preset, so the `jj-hunk` offer is served in a preset session.
What Q3 does kill is the _arithmetic_: the real injection is 89 words ≈ 138
tokens, not ~200 words; moving the 38-word manual saves ≈57 tokens/request, and
the catalog line that replaces it costs 30–77 — a net **−26 tokens** with a short
description and a net **+20** with the 40-word description 28 proposes, with
break-even at ~35 words. So the split should still ship, for the honest reason
that a skill lets the manual be _complete_ (op log, change IDs, conflict model,
the full verb table) instead of capped at 38 words, at zero cost in sessions that
never load it — and the description must be written as a routing rule under ~35
words, not as a summary. The one thing to fix everywhere before shipping is the
sentence "published once per session".

## Still unresolved

| Claim                                                                                            | Status                                                                     | What would settle it                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| A plugin-initiated `ask()` with `wait:{callId: exec.callId}` renders the card in the running GUI | **UNVERIFIED by execution** — code path complete (Q4)                      | mount the probe tool and screenshot the panel |
| The end-to-end answer reaches a host-plane `ask()` for a preset agent in this profile            | **UNVERIFIED by execution** — gate and bridge confirmed (Q5)               | the same probe, answering the panel           |
| Whether the single request lost after overflow compaction ever matters in practice               | **UNVERIFIED** — depends on the model needing the catalog in that one step | instrument a session that overflows mid-task  |
