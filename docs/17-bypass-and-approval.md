# 17 — Bypass and approval (D2, resolved)

**Decision:** deny by default; an explicit, per-call bypass is available through
the harness's own approval channel; never auto-allow.

**Your question was:** *"is it possible we have an explicit bypass required, and
otherwise deny?"* — **Yes.** The harness ships exactly that mechanism, and it
is a better fit than anything we would have built.

## The mechanism: `{ kind: 'ask' }`

`tools/pre-execute` can return four decisions
([11 §1](11-verified-dsh-api-contract.md)):

```ts
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny';  reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask';   reason?: string; displayReason?: { en: string; [locale: string]: string } };
```

`ask` is routed by `dsh-tools` into the approval service
(`dsh-tools/lib/index.js` → `serviceAsk` → `ctx.get('approval').request({…})`),
which prompts the user. The outcome set is
(`@deepseek-ai/dsh-user-approval`):

| Outcome | Effect |
|---|---|
| `allowed-once` | **the only grant** — this one call proceeds |
| `rejected` | the call is denied |
| `cancelled` | the ask was withdrawn (abort signal) |
| `unavailable` | no answerer is composed — fail-closed |

So "explicit bypass required, otherwise deny" is the harness's native shape:
the guard says `ask`, the human says yes or no, and a yes is scoped to **one
call**.

## The trap: `ask` degrades badly under `never`

`ApprovalPolicy` is `'ask' | 'never'`
(`dsh-user-approval/lib/types/index.d.ts`):

- `'ask'` (default) — delegates to the composed answerers; with none composed,
  the chain falls through to the fail-closed `'unavailable'`.
- `'never'` — **never prompts anyone: every ask resolves `'rejected'`
  deterministically.** The documented stance for CI and unattended runs.

And when an ask is rejected, `dsh-tools` does not relay *our* reason — it
substitutes its own:

```js
case 'rejected': return { decision: { kind: 'deny',
  reason: `the user rejected tool "${exec.name}"` } };
```

Under a `never` policy, an `ask` therefore produces **"the user rejected tool
bash"** — which is useless to the model and throws away the entire point of the
verb mapper. The guard must not ask blindly.

## The design

Read the policy first, then choose:

```ts
const approval = ctx.get('approval');
const policy = approval === undefined
  ? 'ask'
  : approval.overrideOf(session) ?? approval.config.policy ?? 'ask';

if (policy === 'never') {
  return { kind: 'deny', reason: verb.reason };          // keep our message
}
return { kind: 'ask', reason: verb.reason, displayReason: verb.display };
```

**The three-term expression is not optional — an earlier draft of this document
had it wrong.** `overrideOf(session)` deliberately returns only the *session
override* and excludes the deployment default, so `overrideOf(session) ?? 'ask'`
misreads every deployment that configured a default. The service's own
resolution is `overrideOf(session) ?? this.config.policy ?? 'ask'`
(`dsh-user-approval/lib/index.js:152-153`), and the base composition sets that
default from the permission mode (`dsh-base/cordis.patch.yml:245-248`):

```js
policy: (DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
```

So under the shipped `danger-full-access` mode, the two-term version concludes
`'ask'` while the service short-circuits to `'rejected'`, and `dsh-tools`
substitutes *"the user rejected tool bash"* — exactly the failure this section
exists to prevent. `ApprovalService.config` is public
(`dsh-user-approval/lib/types/index.d.ts:106`); `effectivePolicy` is private
(`:143`), so this expression is the only plugin-reachable equivalent.

- `setPolicy(agent, policy)` exists, but the plugin must **never** call it. It
  is a user-facing switch; a plugin that changes the session's permission
  posture is doing exactly the thing this design exists to prevent.

### Outcome matrix

| Policy | Command | Guard returns | User sees | Result |
|---|---|---|---|---|
| `ask` | `git commit -m x` | `ask` + our reason | a prompt naming `jj commit` | yes → runs once; no → denied with our reason |
| `ask` | `git status` | `ask` + our reason | a prompt naming `jj status` | same |
| `never` | `git commit -m x` | `deny` + our reason | nothing | denied, model gets the `jj` command |
| **deployment default `never`, no session override** | `git commit -m x` | **`deny` + our reason** | nothing | denied with *our* message — this is the row the two-term expression got wrong |
| `ask`, no answerer | anything | `ask` | nothing | `unavailable` → denied |
| any | `jj new` | `next()` | nothing | allowed |

## The repetition problem

`allowed-once` is per call **by design** — there is no "always allow" outcome
in the service. A user who genuinely wants to run a handful of Git commands
will be prompted once per command.

Two options, and the second is better:

1. **Accept the repetition.** Correct, annoying.
2. **Session-scoped allowlist owned by the plugin.** When the user approves a
   verb, remember `(session, verb)` in memory and return `next()` for that verb
   for the rest of the session. This is *our* state, not the harness's, so it
   must be explicit in the config and visible in the log:

   ```ts
   // config
   bypass: z.union([z.const('ask'), z.const('deny'), z.const('allow')]).default('ask'),
   rememberBypass: z.boolean().default(true),
   ```

   `bypass: 'allow'` is the escape hatch for a user who has decided they want
   Git in this workspace; `bypass: 'deny'` is the CI stance.

Either way, the plugin must **log every bypass** — a permission grant that
leaves no trace is indistinguishable from a bug.

## What the bypass must never be

- **Not automatic.** No "if the command looks safe, allow it". The whole point
  is that a human said yes.
- **Not persistent beyond the session** unless the user wrote it into config.
  **This is now a measured constraint, not a preference.**
  [29](29-state-config-and-sandbox-surfaces.md) §1 establishes there is **no
  per-workspace store** in the harness: the only durable medium is
  `ctx.storage`, and it is scoped to the whole DSH home. A `.jj`-root-keyed
  table would have to use the single-document layout (a path is not a legal
  per-record key), so every write rewrites the whole unit — and the grant would
  silently widen to every project under the home. Persisting the allowlist
  there would contradict this section's own rule. The harness-native durable
  mechanism is a log-only session event plus a projection unit, as
  `dsh-sandbox-policy` does for `sandbox/mode`.
- **Not a silent translation.** Approving `git commit` must run `git commit`,
  not a `jj` equivalent wearing Git's clothes. If the user approves, they get
  what they asked for, with its consequences.
- **Not implemented via `tools.guard`.** Guards are monotonic — no guard can
  force-allow a call another guard denied — so the bypass has to live in our
  `pre-execute` listener. If a `tools.guard` is added later for
  un-overridability, it must consult the same allowlist state.

## Config surface

```ts
bypass:        z.union([z.const('ask'), z.const('deny'), z.const('allow')]).default('ask'),
rememberBypass: z.boolean().default(true),
readOnlyGit:   z.union([z.const('deny'), z.const('ask'), z.const('allow')]).default('ask'),
```

`readOnlyGit` is D2's answer made concrete: read-only Git commands
(`status`, `log`, `diff`, `show`, `branch`, `blame`) default to the same
ask-then-deny posture as mutating ones, and can be relaxed independently.

## Verification status

- `PreToolDecision` union, `serviceAsk`, the rejection message substitution:
  **VERIFIED**, read from `dsh-tools`.
- `ApprovalPolicy`, `overrideOf`, `setPolicy`, `ApprovalOutcome`:
  **VERIFIED**, read from `dsh-user-approval`.
- The end-to-end prompt-then-run flow: **UNVERIFIED** — not yet exercised. It
  should be the first thing a spike proves, before the guard is written.
