# 23 — The correction loop, traced end to end

A worked example. Every seam below is a verified one; the exact payload shapes
come from [11](11-verified-dsh-api-contract.md), the `jj` behaviour from
[13](13-empirical-verification.md).

## The scenario

A session is open on a **colocated** Jujutsu workspace (`jj git init`, so both
`.jj/` and `.git/` exist). The model has just fixed a timeout and wants to save
it. It reaches for the only version control it knows.

---

## Step 1 — the model emits a tool call

```
bash { command: "git commit -am 'fix: increase timeout'",
       description: "Commit the timeout fix" }
```

The harness normalises this into a `ToolExecution`
(`dsh-tools/lib/types/index.d.ts:216`):

```ts
{ callId: 'call_…', rootCallId: 'call_…', token: …,
  name: 'bash',
  arguments: { command: "git commit -am 'fix: increase timeout'",
               description: "Commit the timeout fix" },
  agent: <Agent>, signal: <AbortSignal> }
```

Nothing has run yet.

## Step 2 — the pre-execute waterfall

`dsh-tools` dispatches (`dsh-tools/lib/index.js:3225`):

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () =>
  Promise.resolve({ kind: "allow" }),
);
```

Every listener — ours and every other plugin's — runs in order. Ours is:

```ts
ctx.on('tools/pre-execute', async (exec, next) => { … });
```

## Step 3 — detection

```ts
if (exec.name !== "bash") return next(); // not our call
const session = exec.agent?.session.header.cwd; // canonical session root
if (session === undefined) return next(); // fail open
// the bash tool exposes `workdir`; the command runs THERE, not at the session root
const root = exec.arguments.workdir ? resolve(session, exec.arguments.workdir) : session;
const kind = await detect(root);
// .jj/ is a directory        → it is a jj workspace
// .git/ is also a directory  → colocated
// → 'jj-colocated'
```

Two `ctx.fs.stat` calls. Cached per effective root afterwards.

## Step 4 — classification

`classify` resolves the **invoked program**, not the `git` token
([15](15-verb-mapping.md) §4):

```
split on shell operators      → ["git commit -am 'fix: increase timeout'"]
strip VAR=value, wrappers     → no change
head basename                 → "git"        ← match
verb                          → "commit"
```

Had the command been `jj git export`, the head basename would be `jj` — the
carve-out needs no exception list, because `jj git …` never resolves to the
`git` program.

## Step 5 — choose ask or deny

```ts
const approval = ctx.get("approval");
const policy = approval?.overrideOf(agent.session) ?? "ask";
```

- `policy === 'never'` → return `{ kind: 'deny', reason }`. Our message survives.
- otherwise → return `{ kind: 'ask', reason, displayReason }`.

This is the whole of [17](17-bypass-and-approval.md) in two lines.

## Step 6a — the default deny path (policy `never`, or no answerer)

The waterfall returns:

```ts
{ kind: 'deny',
  reason: "This is a Jujutsu workspace. `git commit` would leave the repo on a "
        + "detached HEAD and jj would silently re-parent your working copy. "
        + "Run `jj commit -m \"…\"` instead (or `jj describe` + `jj new`)." }
```

`dsh-tools` materialises it (`dsh-tools/lib/index.js:889-899`) as the tool
result:

```
Error: This is a Jujutsu workspace. `git commit` would leave the repo on a …
isError: true
```

The tool never runs. The model reads the reason in the tool result and issues
the corrected call.

## Step 6b — the ask path (policy `ask`)

The waterfall returns `{ kind: 'ask', reason, displayReason }`, and `dsh-tools`
routes it (`serviceAsk` → `ctx.get('approval').request({agent, toolName:
'bash', callId, reason, displayReason, signal})`).

**If the user approves** → `allowed-once` → `{ kind: 'allow' }` → the Git
command runs, with its real consequences. An approval is a human decision; the
plugin does not get to substitute a `jj` command for an approved `git` one.

**If the user rejects** → `{ kind: 'deny' }`, and the harness substitutes its
own text (`dsh-tools/lib/index.js:1118`):

```
Error: the user rejected tool "bash"
```

Our carefully written reason is **gone**. This looks like a defect in the
design and is not one:

> A rejection is a human saying _stop_. The model should not immediately run
> the `jj` equivalent. The jj guidance belongs on the **default** path, where
> the model self-corrects without a human in the loop. On the ask path the
> human is the loop.

And the model is not left ignorant: the runtime context from
[22](22-context-injection.md) has already told it what a `jj` workspace is. The
denial message and the injected context are two channels for the same
knowledge, and only one of them is needed at a time.

## Step 7 — the model corrects itself

```
bash { command: "jj commit -m 'fix: increase timeout'",
       description: "Commit the timeout fix" }
```

Classification: head basename `jj` → not Git → `next()` → allowed. `jj` records
the change. Because the workspace is colocated, `jj` keeps `.git` current on its
own — there is no export step to run
([13 §3](13-empirical-verification.md)).

## Step 8 — the hunk-level flow

The model now wants to separate two changes that share a file. It does not
reach for `git add -p` (denied, mapped to `jj-hunk`):

```
jj_hunk_list { query: 'added(content:"from_secs(30)")' }
  → jj-hunk list --format json --query 'added(content:"from_secs(30)")'
  → { files: [ { path: "client.rs", hunks: [ { id: "hunk-2d5ea075…",
        index: 0, type: "replace", added: "…30…" } ] } ] }

jj_hunk_apply { mode: "split", query: 'added(content:"from_secs(30)")',
                message: "fix: increase timeout" }
  → jj-hunk split --query 'added(content:"from_secs(30)")' "fix: increase timeout"
  → Selected changes : kkoutvzx 835738e8 fix: increase timeout
    Remaining changes: xsypwzts d5ffa2d0 mixed changes
```

The timeout change becomes its own commit; the logging change stays in the
working copy. Measured output, [13 §5](13-empirical-verification.md).

Note what the model passed: a **query**, not a hunk ID. IDs regenerate on any
edit ([13 §6](13-empirical-verification.md)), so a two-turn
list-then-apply-by-ID flow would break the moment anything changed in between.

## Step 9 — recovery, if it went wrong anyway

Every mutation, including the split, is in the operation log
([13 §7](13-empirical-verification.md)):

```
$ jj op log
457bb0442a57 create bookmark my-feature …
1695f59b2b92 split commit 9e264c17 …
```

`jj op restore <opId>` undoes it. The plugin exposes this as `jj_op_restore`
rather than inventing an undo mechanism.

---

## The whole loop, condensed

```
model: git commit
   │
   ▼  tools/pre-execute
 detect ── not jj ──▶ next() ──▶ bash runs (plugin invisible)
   │ jj-colocated
   ▼
 classify ── head is `jj` ──▶ next() ──▶ bash runs
   │ head is `git`
   ▼
 policy?
   ├─ never  ──▶ {kind:'deny', reason: <jj command>} ──▶ model self-corrects
   └─ ask    ──▶ {kind:'ask',  reason: <jj command>}
                    ├─ approved ──▶ git runs (human chose it)
                    └─ rejected ──▶ "the user rejected tool bash" (human said stop)
```

## What this walkthrough is not

It is not a test. It is the expected path, assembled from verified seam
contracts. The one link that has never been exercised is **whether the ask
actually reaches a UI and returns an outcome** — marked UNVERIFIED in
[17](17-bypass-and-approval.md), and the first thing a spike should prove.
Everything else here is either read from the installed source or measured
against real `jj`.
