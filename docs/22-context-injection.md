# 22 — Context injection and session steering

**Your question:** _what does DeepSeek Harness provide in its latest release for
injection point?_

**Answer:** `ctx.systemPrompt` — a registry with four registration kinds, a
central order table, and one event waterfall. It is the same seam the harness's
own subsystems use to tell the model what policy is in force, and
`dsh-user-approval` is a near-perfect template for what this plugin needs.

**Release note.** `@deepseek-ai/dsh` `latest` and `next` on npm are both
**`0.2.0-rc.2`** — the version installed here. The only newer publish is
`0.2.1-alpha.2` on the `alpha` tag. Everything below is read from the installed
`0.2.0-rc.2`, so it is the current released surface, not a guess about a future
one.

## 1. The registry

`@deepseek-ai/dsh-system-prompt` mounts `ctx.systemPrompt`
(`SystemPrompt extends Service`). Its own description:

> Registry for ordered system sections, dynamic context, tool schemas, and
> prompt variables.

| Method                                                  | What it registers                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `section({name, order, text, interpolate?, complete?})` | an ordered **system-prompt section**                                      |
| `context({name, order, text})`                          | **dynamic model context, "materialized as a durable user-role snapshot"** |
| `tools(provider)`                                       | a tool-schema provider, evaluated per assembly                            |
| `variable(name, provider)`                              | a `{{variable}}` reference, `[a-z][a-z0-9_]*`                             |
| `suppressRuntimeContext()`                              | suppresses every runtime-context contribution in the scope                |
| `getSectionOrder(name)` / `getContextOrder(name)`       | resolves the centrally owned placement for a named slot                   |

Each returns the exact Cordis effect disposer. Registration and disposal emit
`system-prompt/change`. `text` on both `section` and `context` may be a
**function** evaluated at every assembly — that is what makes the content
dynamic.

Two events are declared (`dsh-system-prompt/lib/types/index.d.ts`):

- `system-prompt/assemble` — an **expert waterfall** over the assembled
  sections, contexts, tools and variables. _"The returned value is
  authoritative."_ A registered `complete` section is restored afterwards, so a
  listener cannot replace the whole prompt.
- `system-prompt/change` — emitted when any provider changes.

## 2. Use the order table, do not invent numbers

`SECTION_ORDERS` and `CONTEXT_ORDERS` are centrally allocated, and the API is
typed against them (`PromptSectionOrderName = keyof typeof SECTION_ORDERS`).
The shipped pattern is to resolve the slot rather than hardcode:

```js
order: ctx.systemPrompt.getSectionOrder("TOOL_BASH"); // → 1000
```

`SECTION_ORDERS` (abridged to what matters here):

| Slot                                     | Order              |
| ---------------------------------------- | ------------------ |
| `HARNESS_IDENTITY`                       | -1000              |
| `DEPLOYMENT_PERSONA_PREFIX`              | 0                  |
| `PLAN_POLICY` / `TEAM_POLICY`            | 500 / 600          |
| `FILE_REFERENCE`                         | 900                |
| `TOOL_BASH`                              | 1000               |
| `TOOL_READ` / `TOOL_WRITE` / `TOOL_EDIT` | 1100 / 1200 / 1300 |
| `TOOL_GLOB` / `TOOL_GREP`                | 1400 / 1500        |
| `MCP_SERVERS`                            | 3100               |
| `TOOLS_SDK`                              | 5000               |
| `DEPLOYMENT_PERSONA_SUFFIX`              | 10200              |

`CONTEXT_ORDERS` has exactly three slots, all owned by harness subsystems:

| Slot                  | Order | Owner                |
| --------------------- | ----- | -------------------- |
| `SANDBOX_POLICY`      | 110   | `dsh-sandbox-policy` |
| `APPROVAL_POLICY`     | 115   | `dsh-user-approval`  |
| `SUBAGENT_DELEGATION` | 120   | `dsh-subagent`       |

**There is no spare slot for a third-party plugin.** This is the one place the
design has to step outside the central table: `dsh-jujutsu` takes the next
context order after the reserved three.

## 3. The canonical pattern

This is `dsh-user-approval`'s own registration
(`dsh-user-approval/lib/index.js:78`), and it is the shape to copy:

```js
ctx.inject(["systemPrompt"], (scope) => {
  scope.systemPrompt.context({
    name: "approval:policy",
    order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY"),
    text: (context) => {
      const agent = context.agent;
      if (agent === void 0) return "";
      return effective(agent) === "never" ? NEVER_SENTENCE : ASK_SENTENCE;
    },
  });
});
```

Four things to take from it:

1. **`ctx.inject(["systemPrompt"], (scope) => …)`** — register inside the
   injected scope, not on the bare context.
2. **Namespaced name** — `"approval:policy"`. Ours is `"jujutsu:…"`.
3. **The provider gets the agent.** `context.agent` is what makes the text
   per-session, and therefore per-workspace. (Note: the declared
   `AssembleContext` is merge-extensible and only declares `scope` and
   `signal`; `agent` is contributed by another module and is what the shipping
   code actually uses. **VERIFIED by usage**, not by the base type.)
4. **Empty string contributes nothing** — _"Empty text contributes nothing."_
   This is the escape hatch that makes conditional injection free.

## 4. The other injection surfaces

| Surface                               | What it is                                                                                                                                                                   | Use for us?                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ctx.systemPrompt.context`            | durable user-role snapshot, per assembly                                                                                                                                     | **yes — primary**                                                                |
| `ctx.systemPrompt.section`            | ordered system-prompt text                                                                                                                                                   | **yes — the rule**                                                               |
| `ctx.systemPrompt.variable`           | `{{var}}` interpolation                                                                                                                                                      | only if a section needs a value                                                  |
| `ctx.systemPrompt.tools`              | tool-schema provider                                                                                                                                                         | **no** — see below                                                               |
| `ctx.tools.register(defineTool({…}))` | the tool registry                                                                                                                                                            | **yes — the eleven tools**                                                       |
| `dsh-agent-instructions`              | loads `AGENTS.md`-compatible files: baseline instructions enter durable context before the first request; fs tool touches project nested/changed instructions into the inbox | **no** — it is a file loader, not a contribution point                           |
| `agent.steer(createUserMessage(…))`   | pushes a message into the agent's next step                                                                                                                                  | **no** for the denial — see §6. `agent.inject` **is** verified-delivered (below) |

On `systemPrompt.tools`: the single tool-schema provider belongs to `dsh-tools`
itself (`dsh-tools/lib/index.js:2707` — `ctx.systemPrompt.tools(context =>
this.wireSchemas(context.scope))`). Individual plugins register into the tool
registry with `ctx.tools.register(defineTool({…}))`
(`dsh-tool-bash/lib/index.js:698`) and `dsh-tools` wires the aggregate into the
prompt. A plugin does not contribute schemas directly.

## 5. The design for `dsh-jujutsu`

Two contributions, both conditional, both silent outside a `jj` workspace.

### 5.1 The rule — a system section

```js
ctx.inject(["systemPrompt", "fs"], (scope) => {
  scope.systemPrompt.section({
    name: "jujutsu:bash-policy",
    order: scope.systemPrompt.getSectionOrder("TOOL_BASH"),
    text: (context) => renderBashPolicy(workspaceOf(context)), // "" outside a jj workspace
  });
});
```

Placed at `TOOL_BASH` (1000) because it qualifies how the `bash` tool is to be
used — the same slot the bash tool itself uses for its own section
(`dsh-tool-bash/lib/index.js:377`, name `"tool:bash"`). The name differs, so
there is no collision.

Content: one short paragraph. Git commands are intercepted in this workspace;
run `jj` instead; the working copy `@` is always dirty; change IDs are the
stable handle; bookmarks are the publish boundary.

### 5.2 The state — a runtime context

```js
scope.systemPrompt.context({
  name: "jujutsu:workspace",
  order: 130, // next free slot after 110/115/120
  text: (context) => {
    const agent = context.agent;
    if (agent === undefined) return "";
    const root = agent.session.header.cwd; // the canonical workspace root
    const kind = detectSync(root); // 'jj' | 'jj-colocated' | 'none'
    return kind === "none" ? "" : renderState(root, kind);
  },
});
```

Content: the concrete state — workspace root, colocated or native, current
`@` change ID, whether `jj-hunk` is available. This is the part that changes
between turns, and it is the reason to use `context` rather than `section`: the
harness materialises it as a **durable user-role snapshot**, so the fact is
restated where the model attends to it rather than buried in a long system
prompt.

**Cost is zero outside a `jj` workspace** — the provider returns `""` and the
contribution disappears.

### 5.3 The tools

`ctx.tools.register(defineTool({…}))` per [18](18-tool-surface.md). Registered
globally; per-scope visibility would be a `@deepseek-ai/dsh-scope` concern and
is out of scope for v0.1. The schema budget is therefore paid on every request,
as [18](18-tool-surface.md) says.

## 6. What not to do

- **Do not use `agent.steer` for the Git denial.** The guard's `reason` already
  reaches the model in-band, attached to the exact call it refused. A steered
  message is out-of-band and arrives detached from the action it is about. The
  one legitimate use would be a session-level notice ("you have entered a `jj`
  workspace"), and the runtime context already covers that.

  **`agent.inject` is a different matter, and it is verified.** It queues
  without waking the driver, and at `agent/turn-stopping` the message is
  delivered **one step later in the same turn** — the loop re-reads the inbox
  after the serial dispatch, and a non-empty next-step cancels the break and
  continues (`dsh-agent-loop/lib/index.js:998-1006`). That makes it the right
  channel for the one actionable per-session alert
  ([27](27-integration-surfaces.md) §1). It is still wrong for the denial:
  in-band beats out-of-band when the model is already looking at the call.
  If the session ends instead of continuing, `cancel()` clears the inbox
  (`:815-820`) — so never rely on it for anything that must survive.

- **Do not set `complete: true`.** Only one complete section is permitted, and
  it replaces the entire system prompt. Claiming it would break the harness.
- **Do not inject a `jj` manual.** Budget: ~200 words total across both
  contributions. The tool descriptions in [18](18-tool-surface.md) carry the
  detail; this is orientation only.

  **Amended — the budget itself is now the thing to shrink.** The harness has a
  better home for the manual: a `jujutsu` **skill** registered with
  `ctx.skills.register()`, whose body costs nothing until the model asks for it
  and whose catalog entry is one line, republished after compaction. Rule and
  state stay here; the manual moves. See
  [28](28-teaching-and-interaction-surfaces.md) §1 and `SPEC.md` §5.9. **But not
  for the token saving an earlier draft claimed** — measured, the split is
  token-neutral (≈57 saved against a 30–77-token catalog line). The real reason
  is that a skill lets the manual be _complete_ instead of capped at 38 words.
  Rule and state cannot move: a skill loads only _after_ the model decides it
  needs one, which is too late to stop the first `git commit`.

- **Do not repeat the tool descriptions.** A model that reads the same
  explanation in the prompt and in eleven schemas pays twice and learns once.
- **Do not touch `system-prompt/assemble`.** It is an expert waterfall over the
  whole assembly; a targeted `context`/`section` registration is the supported
  path.

## 7. Verification status

| Claim                                                                           | Status                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ctx.systemPrompt` exists with `section`/`context`/`tools`/`variable`           | **VERIFIED** — `dsh-system-prompt/lib/types/index.d.ts`                        |
| `context` is materialised as a durable user-role snapshot                       | **VERIFIED** — its own doc comment                                             |
| `getSectionOrder` / `getContextOrder` and the order tables                      | **VERIFIED** — same file                                                       |
| `ctx.inject(["systemPrompt"], scope => …)` + provider receiving `context.agent` | **VERIFIED by usage** — `dsh-user-approval/lib/index.js:78`                    |
| Tools go through `ctx.tools.register`, not `systemPrompt.tools`                 | **VERIFIED** — `dsh-tool-bash/lib/index.js:698`, `dsh-tools/lib/index.js:2707` |
| Order `130` is free and does not collide                                        | **VERIFIED** — `CONTEXT_ORDERS` has only 110/115/120                           |
| The injected text actually reaches the model                                    | **UNVERIFIED** — not exercised end to end                                      |
| `agent.session.header.cwd` is populated for a real assembly                     | **VERIFIED elsewhere** (`dsh-tool-fs` session-cwd), not in this path           |
