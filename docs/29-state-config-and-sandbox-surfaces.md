# 29 — State, config, sandbox policy, and permission presets

Four harness surfaces that could resolve open problems in this design. Each was
read out of the installed `0.2.0-rc.2` source; citations are package-relative.

## 0. Verdicts at a glance

| §   | Surface                                    | Owned by                                                                 | Verdict                                                                             | Effect on the spec                                                                                                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `storage` — persistent plugin state        | `dsh-storage`, `dsh-storage-json`, `dsh-storage-domain`                  | **REJECT** (for the bypass allowlist) · **CONSIDER** (session log instead)          | [17](17-bypass-and-approval.md) keeps its "dies with the session" invariant; the durable-within-a-session option moves to the session log, not a new store |
| 2   | `settingsSchema` / `configForms`           | `dsh-settings`, `dsh-client-ui-settings`, `dsh-client-ui-plugin-manager` | **CONSIDER** — `.volatile()` is required to be visible at all, but buys no controls | `SPEC.md` §6 gains per-field volatility annotations and a note that real controls need a browser half                                                      |
| 3   | `sandboxPolicy` — resolved per-call policy | `dsh-sandbox-policy`                                                     | **USE**                                                                             | Closes [24](24-implementation-plan.md) §6 unknown #7 — **definitively yes**                                                                                |
| 4   | `permissionPresets` — the preset table     | `dsh-permission-presets`                                                 | **REJECT** (as a policy source) · **USE** `approval.config.policy` instead          | Fixes a real defect in [17](17-bypass-and-approval.md) §"The design"                                                                                       |

## 1. `storage` — persistent plugin state

### What it is

Three packages, one stack. The hub does no IO; a backend owns a medium; the
domain layer owns semantics.

| Package              | Provides                                                          | Key surface                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-storage`        | `ctx.storage` hub + named backend registry                        | `Storage extends Service` (`dsh-storage/lib/types/index.d.ts:39`); `backend` registry `:41`; `form(key)` `:57`; `get domain()` `:59`                                                        |
| `dsh-storage-json`   | the `json` backend: one document per unit under a configured root | `Config { root: string }` (`dsh-storage-json/lib/types/index.d.ts:21-24`); registers as backend `json` `:39-43`                                                                             |
| `dsh-storage-domain` | the `domain` data form: zod-validated, change-emitting KV domains | `DomainFacility` (`dsh-storage-domain/lib/types/index.d.ts:52`), `open(spec)` `:83`; `ctx.storageDomain` `:27`; mounts `ctx.storage.domain` (`dsh-storage-domain/lib/index.js:444`, `:450`) |

The unit vocabulary is `KvFacet.open(descriptor)` → `KvUnit`
(`dsh-storage/lib/types/backend.d.ts:26`, `:79`), with `loadAll` / `putRecord` /
`deleteRecord` / `setGlobal` / `close`. The domain layer is what a plugin
actually uses: `open(spec)` returns `Domain<S>` with a `global` handle and
`table(name)` handles whose reads are synchronous from memory and whose writes
are durably ordered on one per-domain chain
(`dsh-storage-domain/lib/types/domain.d.ts:84`, `:36`, `:15`).

A domain is declared once, with zod record schemas and a version
(`dsh-storage-domain/lib/types/spec.d.ts:31-68`, `defineDomain` `:93`).

### The interface a plugin uses

```ts
const spec = defineDomain({
  name: "jujutsu_bypass", // must match UNIT_NAME_RE
  version: 1,
  layout: "single", // default
  tables: { grants: domainTable<GrantKey, Grant>(z.object({/* … */})) },
});

const domain = await ctx.storageDomain.open(spec); // async
ctx.effect(() => () => {
  void domain.close();
}); // the caller owns teardown
domain.table("grants").put(key, value); // durable, awaits the chain
```

`ctx.storage.domain` throws `form-not-mounted` if the domain plugin is absent
(`dsh-storage/lib/index.js:130-136`), and `open` fails loud on an unrouted
backend (`backend-not-found`), a missing `kv` facet (`facet-unsupported`), a
version stamp mismatch, or a record failing its zod schema
(`dsh-storage-domain/lib/types/index.d.ts:65-83`). Every one of those is a
composition-time hazard for a plugin that wants to stay optional.

### Scope

| Question                | Answer                                                                                   | Evidence                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per session?            | **No.** One medium serves the process.                                                   | `Storage.backend` is one registry; `DomainFacility` owns one open-domain table (`dsh-storage-domain/lib/types/index.d.ts:52-63`)                                                                                                                                                                         |
| Per workspace?          | **No.** No such medium exists.                                                           | The backend's only scoping knob is `root` (`dsh-storage-json/lib/types/index.d.ts:21-24`); the domain layer's only routing knob is `routes: domainName → backendName` (`dsh-storage-domain/lib/types/index.d.ts:40-45`)                                                                                  |
| Per profile / DSH home? | **Yes** — this is the real scope.                                                        | `dsh-base` mounts one `storage-json` with `root: dshHomePath('storages')` and one `storage-domain` with `backend: json` (`dsh-base/cordis.patch.yml:168-176`). `dshHomePath` resolves under one harness home: `$DSH_HOME`, else `~/.dsh` (`dsh-home-paths/lib/types/index.d.ts:11`, `:40`, `:48`, `:54`) |
| Partitionable by key?   | **Yes**, and only by key. The store is global; the _partitioning_ is the owner's choice. | `dsh-workspace` is the reference: a global `workspaces` table keyed by `WorkspaceId`, records carrying `path` (`dsh-workspace/lib/types/spec.d.ts:58`; opened at `dsh-workspace/lib/index.js:378`)                                                                                                       |

**Is there a supported per-workspace store? No.** The nearest thing is a global
domain whose table is keyed by a workspace identity, exactly as
`dsh-workspace` does. A `jj` workspace would have to be keyed by its canonical
`.jj` root, which is a path — and a path is not a legal `per-record` key: keys
become path segments and must match `[a-zA-Z0-9_-]+`, an unsafe key rejects
(`dsh-storage/lib/types/backend.d.ts:92-94`). So a path-keyed table forces the
`single` layout, which rewrites the whole unit on every write
(`dsh-storage-json/lib/types/index.d.ts:2-4`).

### Should the "remembered bypass" persist?

[17](17-bypass-and-approval.md) §"The repetition problem" option 2 keeps
`(session, verb)` in memory and states the rule explicitly: _"Not persistent
beyond the session unless the user wrote it into config."_ That rule is correct
and `storage` cannot honour it.

| Route                        | What it buys                                                                  | What it costs                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.storage` domain         | Survives process restart                                                      | A **global-to-the-DSH-home** grant: approving `git commit` in one repo silently permits it in every other repo under the same home. Plus a new domain spec, versioned zod schemas, a write chain, a `ctx.effect` teardown, a fail-open path for compositions without the storage rows, and a path-keyed `single`-layout unit that rewrites wholesale |
| Session log + projection     | Survives restart **by replay of that session** — which is still "the session" | One `session.append(...)` call and one `ctx.sessionProjections.register(...)` unit. No new file, no new package, no new medium                                                                                                                                                                                                                       |
| In-memory `Map` (status quo) | Nothing; dies with the process                                                | Zero                                                                                                                                                                                                                                                                                                                                                 |

The session-log route is the harness's own answer to this exact question.
`dsh-sandbox-policy` documents the pattern for its own per-session override:
_"the session log as the store … so an override survives restart by replay, two
sessions can never see each other's state, and there is no external config
store"_ (`dsh-sandbox-policy/lib/types/session-mode.d.ts:1-17`). The primitives
are `session.append(type, data)` (`dsh-session/lib/types/index.d.ts:246`),
declaration-merged event types via `SessionEventMap`, and
`ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})`
(`dsh-session-projection/lib/types/index.d.ts:150`), read back with `stateOf`
(`:175`). The house convention is to also ship a `./invariant` companion that
validates the event (the `dsh-sandbox-policy` precedent:
`dsh-sandbox-policy/lib/invariant.js`).

**Verdict: REJECT `ctx.storage` for the bypass allowlist. CONSIDER the session
log** if restart-durability within a session is judged worth it. The
security-relevant invariant — a grant never crosses a session boundary and
never crosses a project boundary — holds for the session log and fails for
`storage`.

### Concrete spec change

- [17](17-bypass-and-approval.md) §"What the bypass must never be": keep _"Not
  persistent beyond the session"_ and add the reason — the only supported
  durable medium is global to the DSH home, so persisting there would silently
  widen the grant across projects.
- [17](17-bypass-and-approval.md) §"The repetition problem": state that the
  remembered allowlist is a `Map` keyed by `(sessionId, verb)`, and that if
  restart-durability is ever wanted the mechanism is a log-only session event
  plus a projection unit — **not** `ctx.storage`.
- `SPEC.md` §6: no new config field. `rememberBypass` stays as written.

## 2. `settingsSchema` / `configForms` — plugin config in the UI

### What it is

A two-half system. The host projects each configurable loader entry's exported
`Config` schema into a form; the browser reads that form through a mirror and
writes back through the settings remote.

| Half        | Package                       | Service                                                                            | Role                                                                                                                                             |
| ----------- | ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host        | `dsh-settings`                | `ctx.settings` (`SettingsForms`) (`dsh-settings/lib/types/index.d.ts:62`)          | `describe()` → `SettingsDescriptor[]` keyed by profile entry id (`:96`, `:8-19`); `update` / `replace` / `mutate` write (`:102`, `:108`, `:114`) |
| Host        | `dsh-config-editor`           | `ctx.configEditor` (`dsh-config-editor/lib/types/index.d.ts:10`)                   | `entries()` `:19`, `configuration()` `:23`, `edit(entry, change)` `:34`, `documentPath` `:15` — the profile patch YAML                           |
| Host (wire) | `dsh-api-settings-controller` | —                                                                                  | carries `autoGenerate` and the redacted descriptor to the browser                                                                                |
| Client      | `dsh-client-ui-settings`      | `ctx.configForms` (`dsh-client-ui-settings/lib/types/client/config-form.d.ts:106`) | `get(entryId)` → `ConfigForm` `:142`; `describe()` `:137`; `whileServed(namespaces, register)` `:156`                                            |
| Client      | `dsh-client-ui-settings`      | `ctx.settingsSchema` (`.../client/schema.d.ts:11`)                                 | `rehydrate(schema.toJSON())` `:19`, `validate` `:26`, `nodeAtPath` `:33`, `setPath` `:56`, `deletePath` `:64`                                    |

### How a plugin's `Config` becomes a settings section

| Step | Where          | What happens                                                                                                                                                                                                     |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | the plugin     | `export const Config = z.object({ … })` — a `@deepseek-ai/schemastery` schema                                                                                                                                    |
| 2    | the loader     | the entry becomes an addressable profile row (`ctx.configEditor.entries()`, `dsh-config-editor/lib/types/index.d.ts:19`); `describe()` iterates `configEditor.configuration()` (`dsh-settings/lib/index.js:415`) |
| 3    | `dsh-settings` | reads the schema off the **running fiber**: `entry.fiber.runtime.Config` (`dsh-settings/lib/index.js:538-541`). Only an active fiber qualifies (`:417`)                                                          |
| 4    | `dsh-settings` | `volatileForm(schema)` — and **if that is `undefined` the entry is dropped entirely** (`dsh-settings/lib/index.js:418-419`)                                                                                      |
| 5    | `dsh-settings` | serializes `form.toJSON()` and hardcodes `applies: 'live'` (`:444`, `:446`)                                                                                                                                      |
| 6    | the browser    | a page calls `ctx.configForms.get(entryId)` and writes with `set` / `unset` / `mutate`                                                                                                                           |

**So the answer to "does the plugin have to declare anything beyond exporting
`Config`?" is: yes — every field that should be visible must carry
`.volatile()`.** `volatileForm` returns a field only when it or an ancestor has
`meta.volatile`; with no volatile field anywhere it returns `undefined` and the
entry never appears in `describe()` at all
(`dsh-settings/lib/types/schema.js:43-54`; the drop is
`dsh-settings/lib/index.js:419`).

### What the schema modifiers do to rendering

| Modifier                                                                                              | Effect on the form                                                                                                                                                                                                                                                               | Evidence                                                                                              |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `.volatile()`                                                                                         | Makes the field part of the form, live-editable without remounting the plugin. Its runtime value becomes a `Volatile<T>` (`volatile` → `Volatile<T \| undefined>`, `volatile().required()` → `Volatile<T>`)                                                                      | `schemastery/lib/types/index.d.ts:156`, `:205-207`; `cosmokit/lib/types/volatile.d.ts:7`, `:9`, `:22` |
| (absent)                                                                                              | The field is **not** in the serialized form; a write addressed at it throws `Config field "x" is not volatile`                                                                                                                                                                   | `dsh-settings/lib/index.js:507`; `dsh-settings/lib/types/schema.js:78-84`                             |
| `.role('secret')`                                                                                     | Redaction: `default` and `required` are deleted from the serialized schema, and the field is **removed** from the value while a sidecar records its path and whether it holds a value, so a remote reader never receives the secret but a UI can still render a write-only input | `dsh-settings/lib/types/schema.js:23-26`; `dsh-settings/lib/types/redact.js:1-19`                     |
| `.get()`                                                                                              | Not a modifier — the accessor on a volatile field's runtime value. `plainConfig` unwraps it with `isVolatile(value) → value.get()`                                                                                                                                               | `dsh-settings/lib/types/schema.js:9-18`; `cosmokit/lib/types/volatile.d.ts:9`, `:22`                  |
| `.description()` / `.comment()` / `.link()` / `.badges` / `.disabled()` / `.collapse()` / `.hidden()` | UI metadata carried through `toJSON()` for whatever renders it                                                                                                                                                                                                                   | `schemastery/lib/types/index.d.ts:158`, `:164`, `:168`, `:170`, `:172`, `:174`, `:106-120`            |

`plainSchema` deletes `meta.volatile` before serialization
(`dsh-settings/lib/types/schema.js:19-37`), so the browser sees an ordinary
schema; volatility is a host-side write gate, not a client hint.

### The gap: there are no generated controls

`SettingsDescriptor.autoGenerate` is `true` by default and can be turned off
with `ctx.settings.configure({ auto: false }, ctx.fiber)`
(`dsh-settings/lib/types/index.d.ts:10`, `:74-82`) — but nothing consumes it.
The package's own README says so:

> Each form reports `autoGenerate`, enabled by default, for clients that build
> pages from the schema; **no shipped client does so yet**.
> — `dsh-settings/README.md:39`

**VERIFIED** by exhaustion: `autoGenerate` appears in `dsh-settings`,
`dsh-api-settings-controller` (wire only) and `dsh-api-remotes` (generated
client). No client plugin branches on it. Every shipped settings page is a
hand-written browser plugin:

| Slot                                                            | Declared by                                             | Used for                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.section`                                              | `dsh-client-ui-settings` (`.../contract/slots.d.ts:73`) | a whole page in the Settings shell                                                                                                                                                                              |
| `settings.plugins.tab`                                          | same `:86`                                              | a tab inside the Plugins section; e.g. the read-only inventory registers one (`dsh-client-ui-settings-plugin-inventory/lib/client.js:792`)                                                                      |
| `settings.general.item`                                         | same `:120`                                             | one preference row in General                                                                                                                                                                                   |
| `plugins.item` · `plugins.bundle.config` · `plugins.row.config` | `dsh-client-ui-plugin-manager`                          | a plugin's own config page on the sidebar **Plugins** page; the page supplies `configForm: (id) => ctx.configForms.get(id)` to those slots (`dsh-client-ui-plugin-manager/lib/client.js:937-939`, `:3307-3317`) |

### Verdict

**CONSIDER — with a corrected expectation.**

- **USE `.volatile()`** on every `dsh-jujutsu` field. Without it the nine
  fields are invisible to `settings.describe()`, unwritable through
  `settings.mutate()`, and reachable only as raw YAML in the profile patch
  (`ctx.configEditor.documentPath`, `dsh-config-editor/lib/types/index.d.ts:15`).
  This is a one-line-per-field change with no runtime cost.
- **REJECT "exporting `Config` is enough".** It is not, and `autoGenerate` will
  not save it.
- **CONSIDER shipping a browser half only if controls are actually wanted.**
  That is a second package registering `plugins.item` (official-plugin card) or
  `plugins.bundle.config` (bundle page) and hand-writing a form over
  `ctx.configForms.get('<profile entry id>')` — the same shape as
  `dsh-client-ui-settings-shell` and `dsh-client-ui-settings-agent-loop`.
  That is a real, ongoing cost (a client bundle, locale dictionary, and a form
  per field) for nine fields that are set once.

### Concrete spec change

- `SPEC.md` §6: annotate each field. All nine are read at call time and none
  requires a remount, so all nine can be `.volatile()`:

  | Field                                                         | Volatile | Why                                                                                              |
  | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
  | `enabled`, `guard`, `bypass`, `readOnlyGit`, `rememberBypass` | yes      | read per `tools/pre-execute` call                                                                |
  | `jjPath`, `jjHunkPath`                                        | yes      | read per invocation                                                                              |
  | `hunkInstall`                                                 | yes      | read only when a provisioning prompt is reached                                                  |
  | `injectContext`                                               | yes      | the `systemPrompt` provider is a function evaluated per assembly ([22](22-context-injection.md)) |

- `SPEC.md` §6: add the note that `Config` + `.volatile()` yields live,
  path-addressable config through the settings service, and that user-facing
  controls additionally require a browser-half package. Do **not** claim the
  settings UI renders these fields.
- No `configure({auto:false})` call: there is no generated page to suppress.

## 3. `sandboxPolicy` — the resolved per-call policy

**This closes [24](24-implementation-plan.md) §6 unknown #7.**

### What it is

`dsh-sandbox-policy` registers `ctx.sandboxPolicy`
(`SandboxPolicyService extends Service`, `dsh-sandbox-policy/lib/types/index.d.ts:71`)
and is the single owner of the deployment sandbox fallbacks plus per-session
resolution. It requires `sessionProjections` (`:73`, and
`dsh-sandbox-policy/lib/index.js:105`) and registers the `sandboxMode`
projection unit that folds the `sandbox/mode` session event
(`dsh-sandbox-policy/lib/index.js:114-120`). It also injects a runtime-context
contribution at `systemPrompt.getContextOrder('SANDBOX_POLICY')`
(`dsh-sandbox-policy/lib/index.js:121-130`) — that is the `Current DSH file
policy: …` line the model sees.

| Member                | Signature                                                                                      | Source                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolve(request?)`   | `(req?: { session?: Session; mode?: SandboxMode }) => SandboxExecutionPolicy`                  | `dsh-sandbox-policy/lib/types/index.d.ts:88`               |
| `overrideOf(session)` | `(session) => SandboxMode \| undefined` — the session override without the deployment default  | `:94`                                                      |
| `defaultMode`         | the deployment default                                                                         | `:75`                                                      |
| `workspaceRoot`       | the absolute fallback root for agentless / cwd-less calls                                      | `:77`                                                      |
| `Config`              | `{ mode?: SandboxMode (default 'read-only'); workspaceRoot?: string (default process.cwd()) }` | `:40-48`; `dsh-sandbox-policy/lib/index.js:97-104`, `:113` |

`SandboxExecutionPolicy` is the resolved per-call policy and **yes, it carries a
`workspaceRoot`**:

```ts
interface SandboxExecutionPolicy {
  mode: SandboxMode; // 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string; // absolute root `workspace-write` may write under
  sessionId?: SessionId; // absent for agentless calls
}
```

— `dsh-sandbox/lib/types/index.d.ts:19`, `:27-40` (`workspaceRoot` at `:31`).
It is carried "even under modes that do not consume it so callers can resolve
policy once before choosing the enforcement path" (`:23-25`).

### The exact code path

| Step            | `bash` tool                                                                                                                                                    | a `tools/pre-execute` listener                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| gate            | `const defaultMode = ctx.shell.sandboxMode` — `dsh-tool-bash/lib/index.js:344`                                                                                 | mirror: `ctx.shell.sandboxMode !== undefined`               |
| resolve service | `const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')` — `:346`; **throws at plugin load** if confining and missing — `:347` | `ctx.get('sandboxPolicy')`                                  |
| build request   | `sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })` — `:349`                                                             | identical expression                                        |
| call            | `SandboxPolicyService.resolve(request)` — `dsh-sandbox-policy/lib/index.js:141-148`                                                                            | identical                                                   |
| consume         | `resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)` — `dsh-tool-bash/lib/index.js:649`, body at `:293-299`                                     | `resolveWorkdir(args.workdir, exec, policy?.workspaceRoot)` |

`resolve` is a pure function of its inputs
(`dsh-sandbox-policy/lib/index.js:141-148`):

```js
mode:          request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
...(session === undefined ? {} : { sessionId: session.id })
```

Both callers pass `mode` undefined. `overrideOf` reads the shared projection
fold (`:154-156`). `session.header.cwd` is immutable — "its immutable cwd
becomes the workspace boundary" (`dsh-sandbox-policy/lib/types/index.d.ts:51`).
`defaultMode` and `workspaceRoot` are constructor constants (`:112-113`). The
`exec` object is the same identity-protected call in both places:
`tools/pre-execute` receives a `ToolExecution`, which extends
`ToolExecutionInput` with `readonly agent?: Agent` and `readonly arguments`
(`dsh-tools/lib/types/index.d.ts:47`, `:216-242`), and the tool body receives
that same call.

### Answer: YES

**A `tools/pre-execute` listener can obtain the exact `policyWorkspaceRoot` the
`bash` tool computes, for the same `exec`.** The expression is:

```ts
const sandboxPolicy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get("sandboxPolicy");
const policyWorkspaceRoot = sandboxPolicy?.resolve(
  exec.agent === undefined ? {} : { session: exec.agent.session },
)?.workspaceRoot;
```

Stronger than that: because `resolve` derives `workspaceRoot` from
`session.header.cwd` **and nothing else** whenever the session has a cwd, for
every session with a cwd

```
policyWorkspaceRoot === exec.agent.session.header.cwd
```

— which is exactly what [24](24-implementation-plan.md) §1 already proposes.
The `sandboxPolicy` service is load-bearing in only one case: a session with
**no** `header.cwd`, where it supplies the deployment `workspaceRoot`
(`process.cwd()` in the base composition, `dsh-base/cordis.patch.yml:233`).
So unknown #7 is not a risk to the detector in the ordinary case, and the
service removes even the corner case.

Two residuals, both stated rather than silently taken:

1. **Mirror the gate.** In a composition with an _unconfining_ executor
   (`ctx.shell.sandboxMode === undefined`) and a session with no `header.cwd`,
   `bash` passes `undefined` as `policyWorkspaceRoot`, so `resolveWorkdir`
   falls back to `headerCwd` — also `undefined` — while an unconditional
   resolve would yield `this.workspaceRoot`. Only the `sandboxMode` gate makes
   the two identical. `dsh-shell` exposes the getter
   (`dsh-shell/lib/types/index.d.ts:54`).
2. **Ordering.** Our listener reads inside the `tools/pre-execute` waterfall;
   the `bash` body reads after the whole waterfall and the monotonic guards
   (`dsh-tools/lib/index.js:3225-3226`). A _later_ listener that appends
   `sandbox/mode` would move the fold between the two reads. No shipped
   listener does this, and `setSandboxMode` is a user-facing write path
   (`dsh-sandbox-policy/lib/types/session-mode.d.ts:40-49`); log the resolved
   value if a trail is wanted.

### Verdict: USE

- Add `sandboxPolicy` to the plugin's optional reads. No `inject` entry is
  required: `dsh-tool-bash` itself reads it with a bare `ctx.get("sandboxPolicy")`
  while its `inject` list is only `['tools','shell','systemPrompt','shellEnv']`
  (`dsh-tool-bash/lib/index.js:223-228`, `:346`). `shell` is already in the
  inject list [24](24-implementation-plan.md) §1/§6 #6 proposes, so the gate
  costs nothing.
- Keep `exec.agent?.session.header.cwd` as the primary expression and treat the
  service as the refinement. That keeps the plugin working in a composition
  without `dsh-sandbox-policy`.

### Concrete spec change

- [24](24-implementation-plan.md) §6: mark unknown #7 **settled — yes**, with
  the expression above, and move it out of "unknowns".
- [24](24-implementation-plan.md) §1 "Detection must mirror it": replace the
  bare `policyWorkspaceRoot ?? exec.agent?.session.header.cwd` with the
  resolved form, and add the `ctx.shell.sandboxMode === undefined` gate so the
  unconfining-executor case matches byte for byte.
- `SPEC.md` §7: no behaviour change. This is a correctness fix for
  cross-repo detection, not a new row.

## 4. `permissionPresets` — the preset table

### What it is

`dsh-permission-presets` owns the preset → (sandbox mode, approval policy)
mapping and is the user-facing switch over both knobs. It is a
`TypertRemoteService` (`dsh-permission-presets/lib/types/index.d.ts:95`), so
the catalog is also exposed to clients.

`inject = ['shell','approval','sessions','sessionProjections']` and the
constructor **throws** if the mounted executor does not confine
(`ctx.shell.sandboxMode === undefined`) — "presets bundle a sandbox mode, so
composing this plugin over an unconfined executor is a misconfiguration"
(`dsh-permission-presets/lib/index.js:160-165`, `:177`).

### The interface a plugin uses

| Member                | Signature                                                                                      | Source                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `names`               | `readonly string[]` — configured keys, plus live `auto`                                        | `dsh-permission-presets/lib/types/index.d.ts:133`     |
| `catalog()`           | `() => PermissionCatalog` `{ options, defaultOptions, defaultPreset }`                         | `:138`, `:24-31`                                      |
| `current(session)`    | `(session) => string` — the effective preset name, or `'custom'`                               | `:162`                                                |
| `resolve(name)`       | `(name) => PresetSpec` `{ sandbox, approval, name?, description? }`; throws on an unknown name | `:171`, `:35-44`                                      |
| `optionOf(name)`      | `(name) => PresetOption` — the client-facing label                                             | `:179`, `:12-19`                                      |
| `defaultPreset`       | the resolved default for future sessions                                                       | `:151`                                                |
| `set(session, name)`  | **the write path** — appends `permission/preset` then each changed knob                        | `:186`; `dsh-permission-presets/lib/index.js:344-348` |
| `registerAuto(admit)` | publishes the fixed `auto` preset for an integration's effect lifetime                         | `:145`                                                |

**Can a plugin read the current preset for a session? Yes** —
`ctx.get('permissionPresets')?.current(session)` returns the preset key, or
`'custom'` when the effective knob values match no available preset
(`dsh-permission-presets/lib/index.js:291-306`). Two caveats: it throws
`permission: permissions session projection is not registered` when
`stateOf` returns undefined (`:277-281`), and `'custom'` is not a preset — it is
a derived not-a-preset state, never a switch target or event payload
(`lib/types/index.d.ts:45-49`, `lib/index.js:325-330`).

`current()` and `resolve()` are the read surface; `set()` is the write surface
and must not be called by a plugin — the same rule [17](17-bypass-and-approval.md)
already states for `approval.setPolicy`.

### Default presets and their exact knob values

Package default (`dsh-permission-presets/lib/index.js:138-159`):

| Preset               | `sandbox`            | `approval` | `name`               | `description`                                                                                     |
| -------------------- | -------------------- | ---------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `workspace-write`    | `workspace-write`    | `ask`      | `workspace-write`    | "Write inside the workspace and permitted temporary directories; wider retries require approval." |
| `danger-full-access` | `danger-full-access` | `never`    | `danger-full-access` | "Full file access without approval prompts."                                                      |

The shipped base composition declares its own three-entry table
(`dsh-base/cordis.patch.yml:250-262`):

| Preset               | `sandbox`            | `approval` |
| -------------------- | -------------------- | ---------- |
| `read-only`          | `read-only`          | `ask`      |
| `workspace-write`    | `workspace-write`    | `ask`      |
| `danger-full-access` | `danger-full-access` | `never`    |

Two derived or fixed extras:

| Name     | Bundle                       | Note                                                                                                                                                                                                                                      |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`   | `danger-full-access` + `ask` | fixed bundle (`dsh-permission-presets/lib/index.js:58-61`), live only while an integration holds `registerAuto` (`:258-268`); a _stored_ `auto` identity also matches `never` so a delegated child's reviewer denials stay final (`:302`) |
| `custom` | —                            | derived when nothing matches (`:305`); reserved — the constructor throws if the table names it (`:175`)                                                                                                                                   |

`defaultPreset` is inferred as the preset matching the composed sandbox and
approval defaults when the Config field is omitted
(`dsh-permission-presets/lib/index.js:178-181`).

### Is reading the preset more reliable than `approval.overrideOf(session)`?

**No — it is exactly as reliable about the knobs and strictly less available.**

`derive` resolves the approval knob as
`state.approval ?? ctx.approval.config.policy ?? 'ask'`
(`dsh-permission-presets/lib/index.js:296-297`) — the same two inputs the
approval service itself uses. So `current()` cannot be more reliable than the
approval service about the policy. It is less available: it needs
`permissionPresets` composed (which needs a confining executor, `approval`,
`sessions`, `sessionProjections`) and it returns `'custom'`, which is not a
policy. The guard needs a policy, not a preset name.

**But [17](17-bypass-and-approval.md) §"The design" has a real defect**, and
presets are what exposed it:

```ts
const policy = approval?.overrideOf(session) ?? "ask"; // undefined → deployment default
```

`overrideOf` deliberately does **not** apply the deployment default — "Read the
session override without applying the configured default"
(`dsh-user-approval/lib/types/index.d.ts:144-149`). The service's own resolution
is:

```js
effectivePolicy(session) { return this.overrideOf(session) ?? this.config.policy ?? "ask"; }
```

— `dsh-user-approval/lib/index.js:152-153`, `config` being the public
`ApprovalService.config: Config` (`dsh-user-approval/lib/types/index.d.ts:106`).

So `overrideOf(session) ?? 'ask'` is wrong whenever the **deployment** default
is `never` and the session has no `approval/policy` event — and that is the
shipped configuration:

```yaml
- id: approval
  name: "@deepseek-ai/dsh-user-approval"
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

— `dsh-base/cordis.patch.yml:245-248`.

Under `DSH_PERMISSION_MODE=danger-full-access` the guard as written concludes
`'ask'`, returns `{kind:'ask'}`, the approval service short-circuits
`effectivePolicy === 'never'` to `'rejected'` (`dsh-user-approval/lib/index.js:175`),
`dsh-tools` substitutes its own message
(`reason: 'the user rejected tool "bash"'`, `dsh-tools/lib/index.js:3468-3471`),
and the model never sees the `jj` verb — the exact failure
[17](17-bypass-and-approval.md) §"The trap" was written to prevent. The
`?? 'ask'` comment ("right in practice") is the assumption that fails.

### Verdict

- **REJECT `permissionPresets` as the policy source.** It reads the same
  inputs, needs more composition, and answers a different question.
- **USE `ctx.get('approval')?.config.policy` as the deployment-default
  fallback.** That is the value the harness itself resolves with.
- **CONSIDER `permissionPresets.current(session)` for a log line or a denial
  message** ("preset: workspace-write") — never for the branch.

### Concrete spec change

- [17](17-bypass-and-approval.md) §"The design": replace

  ```ts
  const policy = approval?.overrideOf(session) ?? "ask";
  ```

  with

  ```ts
  const policy =
    approval === undefined
      ? "ask"
      : (approval.overrideOf(session) ?? approval.config.policy ?? "ask");
  ```

  and delete the "`undefined → 'ask'` is right in practice" sentence, replacing
  it with the base composition's `danger-full-access → 'never'` expression as
  the counter-example.

- [17](17-bypass-and-approval.md) §"Outcome matrix": the `never` row is
  reachable from the deployment default, not only from a session override. Add
  a row for "deployment default `never`, no session event".
- [17](17-bypass-and-approval.md) §"Verification status": add that
  `ApprovalService.config` is public (`dsh-user-approval/lib/types/index.d.ts:106`)
  and `effectivePolicy` is **not** (`dsh-user-approval/lib/types/index.d.ts:143`
  is `private`) — so the three-term expression above is the only way for a
  plugin to reproduce the harness's own resolution.
- `SPEC.md` §6: no new field. The preset table is read-only to this plugin.

## 5. What these four settle, together

| Open item                                                                                    | Status after this document                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [24](24-implementation-plan.md) §6 #7 — can the guard read the tool's `policyWorkspaceRoot`? | **Settled: yes**, and for any session with a cwd it is simply `session.header.cwd` (§3)                                               |
| [17](17-bypass-and-approval.md) §"The design" — how to read the approval policy              | **Corrected**: `overrideOf(session) ?? approval.config.policy ?? 'ask'` (§4)                                                          |
| [17](17-bypass-and-approval.md) §"The repetition problem" — should the bypass persist?       | **Answered: not through `storage`.** The medium is global to the DSH home; the session log is the only durable per-session store (§1) |
| `SPEC.md` §6 — how the nine fields reach a user                                              | **Answered: `.volatile()` makes them live and addressable; controls need a browser half nobody has written a generator for** (§2)     |

## Verification status

| Claim                                                                                                  | Status                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage` stack, scope, interface, `form-not-mounted`, path-key key restriction                        | **VERIFIED** — read from `dsh-storage`, `dsh-storage-json`, `dsh-storage-domain`, `dsh-home-paths`, `dsh-base`                                                                                                                                                                                     |
| No per-workspace store; `dsh-workspace` is a keyed global domain                                       | **VERIFIED** — read from `dsh-workspace` and the domain facility                                                                                                                                                                                                                                   |
| Session log + projection is the harness's durable per-session pattern                                  | **VERIFIED** — the `dsh-sandbox-policy` session-mode module doc states it as the design                                                                                                                                                                                                            |
| `Config` + `.volatile()` → `settings.describe()`; non-volatile paths reject writes                     | **VERIFIED** — read from `dsh-settings`                                                                                                                                                                                                                                                            |
| `autoGenerate` has no shipped client consumer                                                          | **VERIFIED** — exhaustive grep; corroborated by `dsh-settings/README.md:39`                                                                                                                                                                                                                        |
| Real settings pages are hand-written client plugins over `configForms.get(entryId)`                    | **VERIFIED** — read from `dsh-client-ui-settings`, `dsh-client-ui-plugin-manager`, and three shipped pages                                                                                                                                                                                         |
| `sandboxPolicy.resolve` is pure and returns the same `workspaceRoot` for the same session              | **VERIFIED** — read from `dsh-sandbox-policy`; the two call sites read from `dsh-tool-bash` and `dsh-tools`                                                                                                                                                                                        |
| `SandboxExecutionPolicy` carries an absolute `workspaceRoot`                                           | **VERIFIED** — `dsh-sandbox/lib/types/index.d.ts:27-40`                                                                                                                                                                                                                                            |
| Default preset tables and the `auto` / `custom` extras                                                 | **VERIFIED** — read from `dsh-permission-presets` and `dsh-base`                                                                                                                                                                                                                                   |
| `approval.overrideOf(session) ?? 'ask'` misreads a deployment-default `never`                          | **VERIFIED by reading**; the end-to-end consequence (model sees "the user rejected tool bash") is **UNVERIFIED** — it is the same live-flow gap as [17](17-bypass-and-approval.md) §"Verification status", and the M0 spike in [24](24-implementation-plan.md) §4 should assert this specific case |
| A later `tools/pre-execute` listener could move the sandbox fold between the guard's read and dispatch | **PLAUSIBLE** — no shipped listener does; stated as a residual in §3                                                                                                                                                                                                                               |

## 3. A per-project switch, and why it is a plugin convention

The question was whether a project could carry an ignored file that turns the
plugin on or off, and whether the harness already had a mechanism for that.

**It does not, and neither does `jj` — in a usable place.** Both halves were
checked against the sources rather than assumed:

| Candidate                      | What it actually is                                    | Why it does not serve                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/settings/settings`   | The harness settings service                           | **No workspace scope.** Settings are profile-global; there is no per-project layer to hang a switch on.                                                                                                              |
| Bundles and patch layers       | `cordis.patch.yml`, `install_bundle`                   | Profile-level. Enabling or disabling a bundle affects every session in the profile.                                                                                                                                  |
| `AGENTS.md` / `CLAUDE.md`      | `packages/context/agent-instructions/src/config.ts:12` | The one per-project file convention the harness _does_ have — but it carries prose instructions, not configuration.                                                                                                  |
| `packages/api/workspace-files` | A read/watch API for the web GUI                       | Previews files in the client. Exposes no mutation and no config.                                                                                                                                                     |
| `jj config set --repo`         | `jj`'s per-repo config                                 | Real, but it writes to `~/.config/jj/repos/<hash>/config.toml` — **outside the workspace**, uncommittable, and readable only via a `jj` subprocess or a reimplementation of `jj`'s path hashing. Verified on 0.46.0. |

So the switch is this plugin's own convention: **`.dsh-jujutsu.json`**, at any
directory level, holding `{"enabled": true|false}`.

```json
{ "enabled": false }
```

- The **nearest** marker walking up from the effective directory wins, so a
  subtree can override its ancestor — disable a monorepo once, re-enable one
  vendored `jj` repo inside it with `{"enabled": true}`.
- No marker means automatic: the plugin follows `.jj` presence, as before.
- It is **JSON**, not TOML. `jj` uses TOML and this file sits beside it, so TOML
  would be the neighbourly choice — but there is no TOML parser in this plugin's
  dependencies or in the harness packages read, and adding a dependency to parse
  one boolean is the worse trade.
- **A malformed marker is treated as absent**, which leaves the plugin _on_.
  That direction is deliberate: a typo must not be a silent way to switch off
  the guard. Every parse failure, unreadable file and wrong-typed value falls
  back to "no marker".

Cost is one `stat` per directory on the way up plus one `readText` on the hit,
cached per directory and dropped by the same invalidation as detection.

Because it is the plugin's own convention, it is the plugin's job to say so:
add `.dsh-jujutsu.json` to `.gitignore` if the switch should stay local, or
commit it if the whole team should get the same behaviour.

## 4. The admin panel, and why it had to be hand-written

Section 2 above describes the host half: `Config` is projected into JSON Schema
with `x-cordis.volatile` on every field, and that projection **is** verified —
`cordis_inspect_query` returns all twelve fields with their defaults.

What it does **not** do is draw anything. `dsh-tinyfish`'s own settings page says
so plainly:

> The harness renders a plugin's settings form only when a client bundle
> contributes a slot to the Plugins page. **It never reads the plugin's `Config`
> schema**, so a package with no client half has no form however well its schema
> is declared, and the harness degrades quietly rather than saying so.

So a well-declared schema is necessary and not sufficient. The panel is
`client/panel.js`, contributed to the **`plugins.bundle.config`** slot keyed
`dsh-jujutsu` — the bundle's own page, between its description and its rows.

**`plugins.bundle.config`, not `plugins.row.config`.** The row slot puts a
configuration behind a Configure control on a single row, which is right for a
bundle declaring several rows with different settings. This bundle declares one
row and one configuration, so the configuration belongs on the plugin's page.
The bundle slot is also simpler by contract: it renders `view: 'page'` **only**,
so there is no `summary` branch to get wrong.

### Why it is plain JavaScript rather than TypeScript

Every other module here is TypeScript that Node strips at import. A client
bundle is different: the web client loads it as a **script** through
`window.__ModuleLoader__.load`, so it must already be JavaScript wrapped in the
CJS factory the loader expects. Producing that normally needs a bundler — the
sibling project uses `vp pack` plus a renaming script. This file is written
directly in the output format instead, which keeps the plugin free of a build
step at the cost of `React.createElement` instead of JSX.

### The panel cannot drift from the schema

The panel is JS and the schema is TS, so nothing at build time connects them.
Two tests are that connection:

- **Coverage** — every field in `Config` is drawn, no field is drawn that
  `Config` does not declare, and each appears in exactly one group.
- **Copy** — every hint shown in the panel appears verbatim in `src/config.ts`.
  A panel that describes a setting differently from the setting's own schema is
  worse than no panel.
- **Execution** — the bundle is loaded with stubbed modules and the factory is
  run, so `buildSpecs`, `booleanField` and `enumField` are exercised rather than
  merely present. `parse` returning `undefined` is what blocks a save on a value
  the field does not accept, and that is asserted directly.

### Controls are built-ins, and one of them does all the work

Every control is a harness primitive, and the field renderer is **`ConfigField`**
— it owns the label, the input, the reset affordance and the validation message,
so the panel draws none of that itself. That is what keeps it looking like the
rest of the settings surface and surviving a restyle.

`ConfigField` is driven by `value: string` plus `choices`:

| `choices`                  | Control                           |
| -------------------------- | --------------------------------- |
| empty                      | a text input (a path)             |
| `["deny", "ask", "allow"]` | a finite choice control (an enum) |
| `["true", "false"]`        | the same control (a boolean)      |

So the field _kind_ selects the control and the panel never reaches for `Switch`
or `SegmentedControl` directly.

**Groups use `DisclosureRow`**, the harness's own disclosure header — one per
group, all open on arrival, since a settings page whose fields are all hidden
makes the user click to discover what is configurable. It is _controlled_
(`open` + `onToggle`, no internal state), so the open state lives in the panel.

An earlier revision drew its own chrome: a `Switch`/`SegmentedControl` per field,
a hand-written row for label, reset and hint, and inline styles throughout. It
worked — it was screenshotted working — but it was this plugin's styling rather
than the harness's, and it would not have followed a restyle. The rewrite
removed every inline style and every hand-rolled element; the panel now
references four primitives and nothing else:

```
primitives.ConfigField         one field
primitives.DisclosureRow       one group
primitives.SettingsForm        the frame
primitives.SettingsFormModel   the drafts
```

### Fields the panel groups

| Group                       | Fields                                             |
| --------------------------- | -------------------------------------------------- |
| Guard                       | `guard`, `readOnlyGit`, `bypass`, `rememberBypass` |
| When there is no repository | `alertUninitialised`, `preferJj`                   |
| Teaching                    | `injectContext`, `teachSkill`                      |
| Binaries                    | `jjPath`, `jjHunkPath`, `hunkInstall`              |
| Master switch               | `enabled`                                          |

The second group is new. A directory with neither `.jj` nor `.git` used to be
indistinguishable from one the detector had merely failed on, so the plugin said
nothing in either case — and an agent could work for an hour in a directory with
no history and never mention it. Detection now names the governing VCS, and the
prompt says so, preferring `jj git init` because a colocated repository keeps
Git tooling working.

### The configuration-slot contract, read from the source

The panel was written against a sibling project's example. Re-checking it against
the harness source found the contract is **narrower and stranger** than that
example suggests, in three ways that each break the panel silently.
`PluginConfigViewProps` is shared by all three configuration slots
(`plugins.item`, `plugins.bundle.config`, `plugins.row.config`), so the findings
below apply whichever one a plugin picks; this plugin picks
`plugins.bundle.config`.

**1. The page supplies the form; the plugin does not build it.**
`packages/client/ui-plugin-manager/src/client/slot-contract.ts`:

```ts
export interface PluginConfigViewProps {
  readonly view: "summary" | "page";
  readonly form?: ConfigPageForm | undefined;
}
export interface ConfigPageForm {
  readonly state: ConfigFormSnapshot<Record<string, unknown>>;
  readonly mutate: ConfigForm<Record<string, unknown>>["mutate"];
}
```

and the page builds it at `PluginManagerPage.tsx:1255`:

```ts
const formFor = (id: string): ConfigPageForm | undefined => {
  if (!configurations?.some((view) => view.ns === id)) return undefined;
  const form = props.configForm<Record<string, unknown>>(id);
  return { state: form.getSnapshot(), mutate: (ops, revision) => form.mutate(ops, revision) };
};
```

`form` is a **narrowed projection** — a snapshot _value_ and a mutate, with no
`getSnapshot`/`subscribe`. `SettingsFormModel` needs a full scope
(`{ getSnapshot, subscribe, mutate }`), which is what `ctx.configForms.get(NS)`
returns. So the panel keeps using `ctx.configForms.get(NS)`, and the `form` prop
is the page's own revision-fenced view for plugins that want to manage drafts
themselves.

**2. `summary` is rendered with no form at all.** `PluginManagerPage.tsx:524`
passes `{ view: 'summary' }` and nothing else; `:528` passes
`{ view: 'page', form }`. A panel that reaches for `props.form` unconditionally
throws on the summary render — which happens on the row's page whenever the
package has no description.

**3. The form is looked up by ROW ID, not by the slot key.** The slot is keyed
`<package name>#<row id>`, but line 1394 passes `formFor(openRow.rowId)`.
`formFor` returns `undefined` unless a settings namespace equals that id — so
**the row id must equal the settings namespace** or the panel is rendered with
no form. It holds here only because both are `dsh-jujutsu`; a test now asserts
it, because nothing else would notice.

### The registration is verified

`Slots.listSubTree` on the configuration slot reports an occupant, and the
occupant reports `active: true`:

### A crashing entry stays on the ledger, inactive

Worth writing down, because it cost more time than anything else here and it is
invisible from the outside.

`SlotCore.reportEntryError` retires a crashing entry from its cell — for the
shadowing kinds (`single`, `keyed`, `list`) it abdicates the entry, one-shot.
Its own documentation is explicit that **"the registration itself stays on the
ledger either way — raw `entries` still lists the entry and its disposer keeps
working."**

So a panel that throws during render produces exactly this:

```json
{ "registrant": "mf", "key": "dsh-jujutsu", "priority": 0, "active": false }
```

An occupant that exists, so a check for "is it registered" passes, and
`active: false`, so nothing renders. **Registration was never evidence the panel
worked**, and this document said "verified live" on that basis. It was wrong.

The crash itself: the panel read its four handlers off the wrong objects.

| Read from                                       | Actually there?                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `field(name).onEdit` / `.onReset` / `.disabled` | **No** — `SettingsFieldState` is `{ text, overridden, invalid }` |
| `shell().onSave` / `.onDiscard`                 | **No** — `SettingsFormShell` is state only                       |

Every verb lives in `model.actions()` — `edit(field, text)`, `resetField(field)`,
`save()`, `discard()` — and `SettingsForm` takes `onSave`/`onDiscard` from there.
Passing four `undefined` handlers made `ConfigField` throw on its first render.
The panel now reads `actions()`, and a test asserts every handler passed to
`ConfigField` and `SettingsForm` is callable, because a throwing render is not a
visible error — the slot swallows it and abdicates the entry.

```json
{ "registrant": "mf", "key": "dsh-jujutsu#dsh-jujutsu", "priority": 0, "active": true }
```

So the client bundle loaded, `apply` ran, and the registration landed under the
exact key the page dispatches. `ctx.configForms.whileServed([NS], …)` **does**
fire — the namespace is served — which was the open question.

Getting here took three corrections, all of them mine:

1. **The key must be `<package name>#<row id>`**, and the page resolves the form
   it passes with `formFor(openRow.rowId)` — so the **row id must equal the
   settings namespace** or the panel renders with no `form`. Both are
   `dsh-jujutsu` here; a test now pins that.
2. **`summary` is rendered with no `form` at all** (`PluginManagerPage.tsx:524`
   passes `{ view: 'summary' }` alone; `:528` passes `{ view: 'page', form }`).
   A panel that reaches for `props.form` unconditionally throws on the summary
   render, which happens whenever the package has no description.
3. **`form` is a narrowed projection** — `{ state: form.getSnapshot(), mutate }`,
   built at `:1255` — with no `subscribe`, so it cannot drive a
   `SettingsFormModel`. `ctx.configForms.get(NS)` returns the full `ConfigForm`,
   which can.

### What is still not verified

The **rendered output**. The registration is confirmed; the pixels are not. I
have not seen the form draw, the controls lay out, or a save round-trip through
`form.mutate`. That needs a person looking at the page.

### The primitives export fewer components than the package contains

`@deepseek-ai/dsh-client-ui-primitives` ships `ConfigField.tsx`, but its
`index.ts` does **not** re-export it. What it exports is:

```
Button, Checkbox, DisclosureRow, SettingsForm, SettingsFormModel,
SettingsSecretField, SettingsValueField, settingsNumberField, settingsTextField
```

So `require(primitives).ConfigField` is `undefined`, and
`createElement(undefined, …)` throws _"Element type is invalid"_. `ConfigField`
belongs to the **generated** forms, not to plugin UIs; the client-facing field is
**`SettingsValueField`**. A file in a package is not an export of it.

The failure mode is the reason this is written down. The slot retires a throwing
entry (`reportEntryError`), so the page renders no form and reports nothing — the
plugin looks like one that simply has no settings. That is how this panel spent
four revisions looking correct while drawing nothing.

`SettingsValueField`'s contract differs from `ConfigField`'s in ways that matter:

| `ConfigField`                           | `SettingsValueField`                              |
| --------------------------------------- | ------------------------------------------------- |
| `value`                                 | `text`                                            |
| `onChange` / `onReset`                  | `onEdit` / `onReset`                              |
| `labels: { reset, inherited, invalid }` | `overriddenLabel` / `resetLabel` / `invalidLabel` |
| `choices` → a `<select>`                | **none** — every kind is a text control           |
| —                                       | `id` required, for the label's `htmlFor`          |

The missing `choices` is the harness's design rather than a gap: a field's
**spec** decides which drafts it accepts, and the control never rewrites what the
user typed. So an enum is typed, and the accepted values belong in the field's
`hint` — which is why every field needs one.
