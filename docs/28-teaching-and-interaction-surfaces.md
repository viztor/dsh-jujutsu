# 28 — Teaching and interaction surfaces

**Your question:** the plugin teaches the model about `jj` by injecting ~200
words of prose into the system prompt on every assembly. Is that the wrong
mechanism, and do `skills`, `commands`, or `userQuestions` do better?

**Answer in one line:** the _rule_ belongs in prompt injection and must stay
there; the _manual_ belongs in a skill; the two human mutations (`bypass`,
`install-hunk`) belong in commands; the model-triggered install consent belongs
in `userQuestions`.

**Source:** DSH `0.2.0-rc.2`, read from the installed packages. Every claim
carries a package-relative `path:line`. Items I could not settle are marked
**UNVERIFIED** with what would settle them.

---

## 0. Verdicts

| Surface             | Verdict                                                                                  | One-line reason                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skills**          | **USE** — for the manual only                                                            | A runtime skill is one catalog line; the body costs nothing until loaded. But a skill is loaded _after_ the model decides it needs it, so it cannot carry the rule that stops the Git command. |
| **Commands**        | **CONSIDER** → **USE** for `/jj bypass`, `/jj install-hunk`; **REJECT** for `/jj` status | Zero model cost, correct driver (human), but the model cannot invoke one and a plugin cannot invoke one either.                                                                                |
| **`userQuestions`** | **USE** for the `jj-hunk` install offer; **CONSIDER** for hunk-selection confirmation    | Structured answers, option lists, free text. Strictly more expressive than `approval.request`. Two real costs: no live-root agent → throws, and headless → `NO_PROVIDER`.                      |

---

## 1. `skills` — the skill catalog service

### 1.1 What it is

`@deepseek-ai/dsh-skill` owns the **Service Definition**; providers own the
content. `ctx.skills` is a `SkillRegistry` (`SkillRegistry extends Service`,
`dsh-skill/lib/types/index.d.ts:225`). It is a **layered** registry — global
layer plus per-scope chains, the same host+per-scope shape as `ctx.tools`
(`dsh-skill/lib/types/index.d.ts:214-224`).

| Member                     | Purpose                                                                       | Cite                                 |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| `registerProvider(create)` | same-process `SkillProvider`; `create(control) => provider`, returns disposer | `dsh-skill/lib/types/index.d.ts:247` |
| `register(skill)`          | **borrowed readonly runtime skill**, body inline                              | `dsh-skill/lib/types/index.d.ts:257` |
| `list(options)`            | sorted invocation-neutral `SkillSummary[]`                                    | `dsh-skill/lib/types/index.d.ts:266` |
| `snapshot(options)`        | summaries + `complete` flag (incomplete is never cached)                      | `dsh-skill/lib/types/index.d.ts:274` |
| `get(name, options)`       | full `SkillDefinition` **including `content`**                                | `dsh-skill/lib/types/index.d.ts:284` |

The provider interface is exactly two methods — `list(options)` returns
candidates, `get(candidate, options)` returns the body
(`dsh-skill/lib/types/index.d.ts:166-186`). Registration is synchronous during
`apply()`; remote/auth work belongs inside `list()`
(`dsh-skill/lib/types/index.d.ts:169-178`).

### 1.2 A skill is both — and a plugin can ship either shape

`SkillSummary` carries an **optional** `path`: _"Absolute instruction file path
when supplied by the provider; absent for virtual skills"_
(`dsh-skill/lib/types/index.d.ts:45-46`). So:

| Shape                                         | Mechanism                                                                                                | Precedent                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Service registration** (no file)            | `ctx.skills.register({name, description, content, source, ...})`                                         | the API itself, `dsh-skill/lib/types/index.d.ts:257` |
| **File, shipped in the plugin's own package** | `ctx.skills.registerProvider(...)` whose `get()` reads `new URL("../assets/<name>.md", import.meta.url)` | `dsh-skill-badge/lib/index.js:11-15, 29-51`          |
| **File, discovered from disk**                | `dsh-skill-filesystem` scans roots                                                                       | `dsh-skill-filesystem/lib/index.js:150-188`          |

`SkillRegistration` is `Omit<SkillDefinition, 'invocation' | 'provider'>`, so
`name`, `description`, `content` and **`source`** are required; `invocation`
and `provider` get defaults (`dsh-skill/lib/types/index.d.ts:78-84`).
`register()` fills `invocation: {modelInvocable: true, userInvocable: true}` and
`provider: "runtime"` when omitted
(`dsh-skill/lib/index.js:201-208`). Validation is only name grammar +
non-empty description (`dsh-skill/lib/index.js:465-469`). A duplicate runtime
name in one layer is **first-wins with a no-op disposer and a warning**
(`dsh-skill/lib/index.js:197-200`).

**Precedence.** Lower rank wins a duplicate name _within one layer_:
project-dsh `100`, project-agents `200`, runtime `250`, custom `300`, user-dsh
`400`, user-agents `500`, bundled `600`
(`dsh-skill-filesystem/lib/index.js:21-25`,
`dsh-skill/lib/index.js:21-23`). A runtime registration therefore **loses** to
a project skill of the same name — which is the right default: a repo can
override our `jujutsu` skill.

### 1.3 The cost model — this is the whole point

Two separate lifecycles:

**Catalog.** `dsh-tool-skill` publishes a durable user message at
`agent/pre-step` (`dsh-tool-skill/lib/index.js:203-236`) containing
`<available_skills>` with **one line per skill**:
``- `name`: description`` (`dsh-tool-skill/lib/index.js:293-295`). The
description is whitespace-normalized and truncated at
`catalogDescriptionMaxLength`, **default 500**
(`dsh-tool-skill/lib/index.js:40, 49, 359-362`).

Republishing is digest-gated: a new message is emitted only when the entry
digest changes, and a duplicate is filtered out when the visible catalog
already matches (`dsh-tool-skill/lib/index.js:216-235, 301-304`). The catalog is
therefore **one line, published once and republished after compaction**, and thereafter it rides the
transcript as history. When there are no model-invocable skills and nothing was
ever published, no catalog message is emitted at all
(`dsh-tool-skill/lib/index.js:227-230`).

**Body.** Only on load, via the `skill` tool
(`dsh-tool-skill/lib/index.js:59-66, 138-157`), rendered as one canonical
`<skill_content>` block (`dsh-skill/lib/types/index.d.ts:134-143`). Once loaded
it stays in the transcript.

**Two invocation paths.**

| Driver | Trigger                                  | Check                                                                                               |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Model  | calls `skill` with an exact catalog name | `isModelInvocable` — `dsh-tool-skill/lib/index.js:145-150`                                          |
| User   | types `/name` anywhere in a user message | `SKILL_GESTURE` regex, then `isUserInvocable` — `dsh-tool-skill/lib/index.js:373, 381-394, 168-202` |

Both render the identical block, so there is one shape to write against.

**Also model-visible:** `ctx.remote.skills.list` (Remote namespace `skills`)
serves the GUI, user-invocable only, **without bodies**
(`dsh-api-session-controller/lib/types/skill-catalog.d.ts:12-25`,
`dsh-api-session-controller/lib/types/skill-catalog.js:106`).

### 1.4 It is mounted, and the deployment documents our exact case

Host bundle rows: `skill` (registry), `skill-filesystem`, `tool-skill`;
`skill-badge` disabled (`dsh-base/cordis.patch.yml:294-305`).

`dsh-web-app` disables the host `skill-filesystem` and `tool-skill` rows and
says why, verbatim:

> The `skill` REGISTRY stays in the host plane. It is host+per-scope layered
> (the tools-registry shape): deployment-level providers — repository plugins,
> a host skill-filesystem row — register into its global layer, while a preset's
> `skill-filesystem` registers into that preset's layer, and each agent reads the
> merged catalog its scope chain selects.

(`dsh-web-app/cordis.patch.yml:474-488`.) Presets mount their own
`skill-filesystem` + `tool-skill`
(`dsh-web-app/presets/standard.patch.yml:34-37`).

**So `dsh-jujutsu`, a repository plugin in the global layer, registering a
global runtime skill, is the documented intended case.** The agent's preset
publishes it.

The preset also proves the packaged-directory route: `customSkillDirs` is
pointed at the **`skills/` directory inside an installed package**
(`dsh-web-app/presets/cordis.patch.yml:146-147`), and `dsh-skill-office` ships
`assets/office-pptx/SKILL.md`, `assets/office-docx/SKILL.md`,
`assets/office-xlsx/SKILL.md` read through `fileURLToPath(new URL("../assets/",
import.meta.url))` (`dsh-skill-office/lib/index.js:55-57`).

### 1.5 Verdict — **USE**, for the manual, not for the rule

| Content                                                                          | Home                   | Why                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The rule** — "Git is intercepted here; run `jj`"                               | stays prompt injection | It must be in force **before** the model emits a Git command. A skill is loaded only _after_ the model decides it needs one, and it decides that from the catalog line — which says nothing about this workspace being `jj`. Moving the rule into a skill means the first Git command of every session still happens. |
| **The manual** — working-copy model, change IDs, bookmarks, op log, verb mapping | **`jujutsu` skill**    | It is reference material consulted on demand. Its correct cost is zero until the model asks.                                                                                                                                                                                                                          |
| **The state** — root, colocated?, current `@`                                    | stays runtime context  | Not teachable content; it is a fact about the workspace.                                                                                                                                                                                                                                                              |

**Cost, stated honestly.** A skill does not make the manual free — it makes it
_deferred_. The catalog line is paid every request for the rest of the session,
and the body is paid every request after the first load. What it buys is that
the body is paid **only in the sessions that needed it**, where a system-prompt
section is paid in every session, including the ones that never touch a hunk.

**The description is the trigger, not a summary.** Because it is the only
routing signal, it must name Git explicitly. It ships at **206 characters /
33 words**, under the 214-character break-even [32](32-probe-results-teaching.md)
§Q3 measured — below that line the catalog entry costs no more than the
injection it replaced, above it the split is a net cost. Read it as a routing
rule (`...when a Git command is refused, when the user says "commit", "branch",
"rebase", or "undo"...`), not as a table of contents.

**The body is a card, not the manual.** A skill body can be long, but length is
still paid whenever it loads, and `jj help <subcommand>` / `jj help -k <topic>`
are local, free and version-matched. So the card keeps only what the binary
cannot answer — the Git-to-`jj` intent map, the plugin's eleven tools, the hunk
query language — and names `jj help` as the source of truth for flags, syntax and
edge cases. It measured 1,185 words when written and ~670 after the trim, with a
test ceiling of 800 so it cannot regrow. Because a skill nobody notices is a file
nobody reads, the runtime state carries one pointer line (13 words) naming it;
that line is the only manual cost paid on every assembly.

**Concrete change to `SPEC.md`:**

1. Insert a new **§5.9 The `jujutsu` skill** after §5.6 (SPEC.md:336-347):
   `ctx.skills.register({name:'jujutsu', source:'bundled', description:<routing
   rule>, content:<manual>})` inside `ctx.inject(['skills'], …)`, so a host with
   no `ctx.skills` degrades silently instead of failing plugin load. The body
   lives in `src/skill.ts` as a template literal (it must be readable in the
   plugin's own source; a `SKILL.md` shipped as an asset is the alternative).
2. Amend §5.6's budget sentence: the ~200 words are now the **rule + state
   only**; the manual is out of the prompt.
3. Add to §6 Config: `teachSkill: z.boolean().default(true)` — registering a
   skill mutates the session's catalog, so it is a user-reversible decision,
   exactly like `injectContext` (SPEC.md:416).

**And the matching edit to `docs/22-context-injection.md:202`** — replace
_"Do not inject a `jj` manual"_ with _"Do not inject a `jj` manual — it is the
`jujutsu` skill ([28](28-teaching-and-interaction-surfaces.md) §1)."_

---

## 2. `commands` — the slash-command system

### 2.1 What it is

`@deepseek-ai/dsh-commands` mounts `ctx.commands` (`CommandRuntime extends
TypertRemoteService`, `dsh-commands/lib/types/index.d.ts:80`) and is mounted on
the **host plane** in the base bundle (`dsh-base/cordis.patch.yml:307-308`), not
disabled by `dsh-web-app`.

Registration is one object:

```ts
ctx.commands.register({
  definitionId: CommandDefinitionId("@scope/pkg"),  // optional, for client behavior
  name: "jj",                    // lowercase, no slash
  description: "…",              // discovery UI
  input: { hint, attachments? }, // optional
  recordInput: true,             // default; false when a domain event owns the payload
  handler: (invocation) => CommandResult | Promise<CommandResult>,
})
```

(`dsh-commands/lib/types/index.d.ts:37-55, 94`.)

### 2.2 What a command gets

| Field         | Meaning                                                                  | Cite                                      |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `commandId`   | pairing id already written to `command/run`                              | `dsh-commands/lib/types/index.d.ts:20-21` |
| `agent`       | **the exact Agent** whose UI received it                                 | `dsh-commands/lib/types/index.d.ts:22-23` |
| `rawInput`    | verbatim text after the name, separator whitespace included              | `dsh-commands/lib/types/index.d.ts:24-25` |
| `attachments` | durably admitted image/file blocks, only if `input.attachments` declared | `dsh-commands/lib/types/index.d.ts:26-33` |
| `signal`      | cancellation owned by the dispatching UI request                         | `dsh-commands/lib/types/index.d.ts:34-35` |

Return is closed: `{kind:'success', text?, sourceEventSeq?}` or
`{kind:'error', text}` (`dsh-commands/lib/types/types.d.ts:32-41`). The
handler runs **"against the receiving agent without sending the command to the
model"** (`dsh-commands/lib/types/index.d.ts:53`).

**Writing back to the model.** The handler owns the agent, so it has the whole
`Agent` runtime surface. The shipped precedent is `/goal`:

```js
invocation.agent.followup(createUserMessage({ content: [...], source: {kind:'user'} }))
```

(`dsh-command-goal/lib/index.js:98-107`). `Agent.followup(message)` queues an
ordinary follow-up turn and wakes the driver
(`dsh-agent/lib/types/runtime-types.d.ts:192`). `Agent.inject(message)` queues
model-facing context for the next pre-step **without waking the driver**
(`dsh-agent/lib/types/runtime-types.d.ts:209`) — the right one for a
status-style `/jj`. A handler can also write the session log directly:
`/feedback` calls `session.append("feedback/record", …)`
(`dsh-command-feedback/lib/index.js:75-81`).

Lifecycle is logged, not surfaced: `command/run` before the handler,
`command/done` after settlement, both log-only, both keyed by `commandId`
(`dsh-commands/lib/types/types.d.ts:89-119`,
`dsh-commands/lib/types/index.d.ts:114-142`).

### 2.3 User-only — confirmed three ways

1. `CommandSourceMap` has **exactly one member**: `{kind:'user'}`, with the
   doc comment _"minimal because every executor caller is a human-facing UI
   surface dispatching a human-typed line, so the sole variant is `user`"_
   (`dsh-commands/lib/types/types.d.ts:65-77`).
2. Every caller of `commands.execute` / `commands.list` in the installed tree
   is a **client**: `dsh-client-ui-commands/lib/client.js:782, 1069`,
   `dsh-client-ui-plan/lib/client.js:704`,
   `dsh-api-session-controller/lib/types/client/sessions/session.js:293`. No
   host tool, no prompt section.
3. No `SECTION_ORDERS` slot advertises commands to the model — the full table
   runs `TOOL_BASH` … `MCP_SERVERS` … `DEPLOYMENT_PERSONA_SUFFIX` with no
   command entry (`dsh-system-prompt/lib/types/index.d.ts:113-146`).

**Corollary: a plugin cannot invoke a command either.** `ctx.commands.execute`
is reachable only through the Remote from a client. So a command can never be
an internal implementation detail — it is always a user gesture.

**Red herrings.** `dsh-native-command` is host-native _process_ execution and
path opening (`dsh-native-command/lib/types/index.d.ts:1-12`).
`dsh-cmdline` is process `argv` handed to the app by the launcher
(`dsh-cmdline/lib/types/index.d.ts:1-16`). Neither is the slash-command system.

### 2.4 Verdict — **CONSIDER**, with two USE and one REJECT

| Command                      | Verdict    | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/jj bypass on\|off\|status` | **USE**    | This is the single best fit. D2's bypass is currently a **config edit** (`bypass` at SPEC.md:410) plus a per-call approval prompt ([17](17-bypass-and-approval.md)). A command makes it a session-scoped, logged, human gesture with zero model tokens. `Agent.inject` can tell the model the posture changed without waking a turn. Precedent for the config-not-code shape: `/goal`'s `create/edit/pause/resume/clear` grammar over one `rawInput` (`dsh-command-goal/lib/index.js:19-35`). |
| `/jj install-hunk`           | **USE**    | D3's install is a **user-owned system mutation** ([19](19-jj-hunk-provisioning.md)). Making it a command removes the awkward "model asks the user to ask the plugin" loop and gives `hunkInstall: 'auto'` a manual equivalent. Long-running work fits the handler's async + `signal` contract; a `sourceEventSeq` result can point at the install log.                                                                                                                                        |
| `/jj` (status)               | **REJECT** | Zero marginal value. The user can already ask the model, and the model's answer includes the `jj` state the model actually needs. A registration + a UI row + a lifecycle event pair for a status dump is cost without a decision attached.                                                                                                                                                                                                                                                   |

**The install command does not replace the model-triggered offer.** The offer
fires when `jj_hunk_list` fails ([19 §The offer](19-jj-hunk-provisioning.md));
a command fires when the human decides. They are complementary, and §3 below
covers the model-triggered half.

**Concrete change to `SPEC.md`:**

1. Insert a new **§5.10 Human commands** after the new §5.9: three rows
   (`bypass`, `install-hunk`), `ctx.inject(['commands'], …)`, handlers in
   `src/commands.ts`, and the `definitionId` `CommandDefinitionId("dsh-jujutsu")`.
2. Rewrite the `bypass` story: `SPEC.md:408-411` and
   [17 §Config surface](17-bypass-and-approval.md) keep the **config default**,
   but the command becomes the documented way to change it mid-session, and the
   config field becomes "the starting posture", not "the only switch".
3. Add to §3 package shape (SPEC.md:87-95): `src/commands.ts`, `src/skill.ts`.
4. Note in §5.10 that commands are **invisible to the model** — so the rule text
   must not mention `/jj`, because the model will confidently tell the user to
   type a command it cannot see is registered. **UNVERIFIED**: whether a
   deployment could ever hide a command; I found no per-command visibility flag
   in `CommandDefinition` (`dsh-commands/lib/types/index.d.ts:37-55`).

---

## 3. `userQuestions` — structured questions to the user

### 3.1 What it is

`@deepseek-ai/dsh-user-questions` owns `ctx.userQuestions`
(`UserQuestionService extends TypertRemoteService`,
`dsh-user-questions/lib/types/index.d.ts:35`), mounted on the host plane
(`dsh-base/cordis.patch.yml:71-72`). The model-facing consumer is
`@deepseek-ai/dsh-tool-ask-user`, mounted **per preset**
(`dsh-web-app/presets/standard.patch.yml:131-132`; absent from
`presets/minimal.patch.yml`).

The service is _validation plus a scoped answerer waterfall_
(`dsh-user-questions/lib/types/index.d.ts:34`). The UI half is the Client
package `dsh-client-ui-user-questions`
(`dsh-web-app/cordis.patch.yml:424-425`), whose listener is
`ctx.remote.$on("user-questions/request", …)`
(`dsh-client-ui-user-questions/lib/client.js:1927`).

### 3.2 The request/response shape

```ts
// request
{ questions: AskUserQuestionItem[], agent?, signal?, wait?: {callId, timed?} }

AskUserQuestionItem = {
  id: string;                    // stable, echoed in the answer
  question: string;
  detail?: string;               // supporting detail, kept out of option labels
  header?: string;               // short heading, e.g. "Confirm"
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;         // default single-select
  intent?: { kind: 'plan-review'; approve: string; callId? };
}

// response
AskUserQuestionAnswer = {
  answers: { id: string; selected: string[]; custom?: string }[]
}
```

(`dsh-user-questions/lib/types/types.d.ts:5-61`.) A skipped question is an
answer item with empty `selected` and no `custom`; `selected: []` plus
`custom` is a free-text answer
(`dsh-tool-ask-user/lib/index.js:151, 165`).

The event declaration:

```ts
'user-questions/request'(
  this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>
): Promise<AskUserQuestionAnswer>
```

— a **waterfall**, scope-filtered so agent-scoped listeners receive only that
agent (`dsh-user-questions/lib/types/types.d.ts:136-146`). Return an answer to
claim, `next()` to delegate. The `ask_user_question` tool schema is the
model-facing projection of the same shape (`dsh-tool-ask-user/lib/index.js:223-321`).

### 3.3 A plugin can call it directly

**Yes.** `ask(request)` is a public method on the service:

```ts
ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

(`dsh-user-questions/lib/types/index.d.ts:98`; implementation
`dsh-user-questions/lib/index.js:668-690`.) `AskUserQuestionRequest extends
AskUserQuestionRequestEvent` with `agent` required
(`dsh-user-questions/lib/types/index.d.ts:22-24`). It is **not** gated behind
the tool.

Four gates, all fail-closed:

| Gate                                                        | Failure            | Cite                                           |
| ----------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| Already aborted                                             | `ASK_ABORTED`      | `dsh-user-questions/lib/index.js:669`          |
| Zero questions                                              | `EMPTY_QUESTIONS`  | `dsh-user-questions/lib/index.js:670`          |
| `agent` supplied but not the registry's exact live instance | `CALLER_NOT_LIVE`  | `dsh-user-questions/lib/index.js:533`          |
| `agent` is owned by another live agent                      | `DELEGATED_CALLER` | `dsh-user-questions/lib/index.js:534`          |
| No answerer claims it                                       | `NO_PROVIDER`      | `dsh-user-questions/lib/index.js:679, 681-684` |

There is also `askTimed(request, callId, timeoutMs)`, which returns either the
answer or `{pending:true, callId}` and is what the opt-in `timed` tool mode
uses (`dsh-user-questions/lib/types/index.d.ts:79-81`; tool config default is
`legacy`, i.e. blocking — `dsh-tool-ask-user/lib/types/index.d.ts:11-18`).

### 3.4 Versus `approval.request`

`ApprovalService.request(req)` returns `ApprovalOutcome = 'allowed-once' |
'rejected' | 'cancelled' | 'unavailable'` (`dsh-user-approval/lib/types/types.d.ts:22-26`;
`dsh-user-approval/lib/types/index.d.ts:135`). The request carries `toolName`
(required), `callId?`, `reason?`, `displayReason?`
(`dsh-user-approval/lib/types/types.d.ts:54-71`) — **no answer channel at all**.

|                                 | `approval.request`                                                                                                                    | `userQuestions.ask`                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Return                          | one of four enum values                                                                                                               | structured `answers[]`                                                          |
| Options presented               | no (the UI renders the tool call)                                                                                                     | **yes**, labelled options + descriptions                                        |
| Free text                       | no                                                                                                                                    | yes (`custom`)                                                                  |
| Multi-select                    | no                                                                                                                                    | yes (`multiSelect`)                                                             |
| Non-tool caller                 | needs an **open turn** (`dsh-user-approval/lib/index.js:130`), not a live root                                                        | needs the **exact live root agent** (`dsh-user-questions/lib/index.js:533-534`) |
| From a subagent                 | works — no live-root check anywhere in `dsh-user-approval/lib/index.js`                                                               | **throws `DELEGATED_CALLER`**                                                   |
| No answerer                     | `unavailable` (fail closed)                                                                                                           | throws `NO_PROVIDER`                                                            |
| Audit                           | `approval/asked` + `approval/decided` log pair                                                                                        | none of its own                                                                 |
| Degrades under `policy:'never'` | **auto-`rejected`**, and `dsh-tools` substitutes its own reason: `the user rejected tool "bash"` (`dsh-tools/lib/index.js:3468-3472`) | unaffected — approval policy does not gate it                                   |

Two consequences that decide the design:

- **The approval channel is the wrong one for a choice.** It cannot return
  _which_ of three install strategies the user picked, and under `never` it
  cannot even preserve our wording.
- **The question channel is the wrong one for the guard.** The guard's decision
  must be a `PreToolDecision`, which is what routes into `approval`; the guard
  cannot call `userQuestions.ask` and then map an answer to a decision without
  inventing a blocking tool call. More importantly, a subagent's `git commit`
  would throw `DELEGATED_CALLER` instead of prompting.

### 3.5 Verdict

**(a) The `jj-hunk` install offer — USE.** This is a decision with more than two
outcomes, and it wants a structured answer:

```
jj_hunk_list → jj-hunk missing
  ctx.userQuestions.ask({
    agent: exec.agent,
    signal: exec.signal,
    questions: [{
      id: "jj-hunk-install",
      header: "jj-hunk",
      question: "jj-hunk is not installed. It is required for hunk-level operations.",
      detail: "<pinned rev> → cargo install --git … --rev <sha> jj-hunk (~40 s)",
      options: [
        { label: "Install now", description: "Runs cargo install with the pinned rev; ~40 s." },
        { label: "Show me the command", description: "Return the command; install nothing." },
        { label: "Never ask again", description: "Set hunkInstall=never for this session." },
      ],
    }],
  })
```

That collapses [19](19-jj-hunk-provisioning.md)'s three branches
(`ask` / `never` / `auto`) into one answer, records the "never" choice as a real
user decision rather than a config guess, and keeps the human informed about the
supply-chain surface. **Cost:** `ask` throws `NO_PROVIDER` when no client UI is
attached, which is a _harder_ failure than approval's `unavailable`; the handler
must catch it and fall back to "return the command" (the `hunkInstall:'never'`
path). Same net behaviour, one extra `catch`.

**(b) A hunk-selection confirmation — CONSIDER, not USE.** Where the model has
already computed a hunkset and wants the human to confirm _which_ hunks, the
question channel is genuinely better than approval: labelled options per hunk,
`multiSelect: true`, and `custom` for "none of these". But two problems:

1. **`DELEGATED_CALLER`.** A subagent doing the hunk work cannot ask. The
   approval channel can. If hunk splitting is delegated — and it is exactly the
   kind of mechanical work that gets delegated — the structured path is
   unavailable and approval is the only one left.
2. **No `callId`.** The legacy tool passes `wait: {callId}`, and the Client card
   is created with that id (`dsh-client-ui-user-questions/lib/client.js:1760-1761`).
   A plugin calling `ask()` has a `ToolCallId` available from `exec.callId`, so
   this is fixable — but whether a card keyed to a _plugin's_ call renders
   correctly is **UNVERIFIED**. What would settle it: mount a probe plugin that
   calls `ctx.userQuestions.ask` with `wait: {callId: exec.callId}` from inside
   a tool body and watch the GUI.

Because (b)'s two blockers are cheap to remove and the gain is real, it is worth
a spike before the hunk-confirmation design is frozen. Until then, hunk
confirmation stays on `approval` — the same channel the guard already uses, so
there is one confirmation grammar in the plugin, not two.

**Concrete change to `SPEC.md`:**

1. Insert a new **§5.11 Asking the user** after §5.10, with the (a)/(b) split
   above, the `NO_PROVIDER` fallback, and an explicit rule: _the guard never
   calls `userQuestions`; the hunk bridge may._
2. Rewrite [19 §The offer](19-jj-hunk-provisioning.md) to route through
   `ctx.userQuestions.ask()` with the three labelled options, keeping the
   `hunkInstall:'never'` and `cargo`-missing branches as the fallbacks. Drop the
   "ask once per session, cache the answer" bullet — the "Never ask again"
   option _is_ that cache, and it is now explicit.
3. Add to §6 Config: no new field; the "never ask again" choice is session
   state, not config, and must be logged.

---

## 4. Comparison

Cost is per **request** once the mechanism is in effect. "Durable" means the
content stays in the transcript and is re-sent as history.

|                              | Prompt injection — `systemPrompt.section`             | Prompt injection — `systemPrompt.context`          | Skill catalog line                             | Skill body                             | Command                                        | `userQuestions.ask`                            |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| **Provider**                 | `dsh-system-prompt`                                   | `dsh-system-prompt`                                | `dsh-tool-skill`                               | `dsh-skill` + `dsh-tool-skill`         | `dsh-commands`                                 | `dsh-user-questions`                           |
| **Cost before first use**    | full text, every request                              | full text, first request                           | one line (`≤500` chars)                        | **zero**                               | **zero**                                       | **zero** (schema already paid by the harness)  |
| **Cost after**               | full text, every request                              | durable; re-emitted **only when the text changes** | durable, one line                              | durable, unbounded                     | zero                                           | zero                                           |
| **Cite for cost**            | `dsh-system-prompt/lib/types/index.d.ts:55-69, 71-79` | `dsh-agent-loop/lib/index.js:334-350`              | `dsh-tool-skill/lib/index.js:293-295, 216-235` | `dsh-tool-skill/lib/index.js:138-157`  | `dsh-commands/lib/types/index.d.ts:53`         | `dsh-tool-ask-user/lib/types/index.d.ts:11-21` |
| **Discoverability**          | always in force, never "discovered"                   | always in force                                    | name + description in `<available_skills>`     | only after a load                      | **none for the model**; `/` menu for the human | only via the `ask_user_question` tool schema   |
| **Driver**                   | harness, per assembly                                 | harness, per assembly                              | **model** (or user via `/name`)                | model or user                          | **user only**                                  | **model** (or a plugin)                        |
| **Can a plugin register it** | yes — `section`                                       | yes — `context`                                    | yes — `ctx.skills.register`                    | yes — `register` or `registerProvider` | yes — `ctx.commands.register`                  | n/a — the plugin _calls_ it                    |
| **Can the model trigger it** | n/a                                                   | n/a                                                | yes                                            | yes                                    | **no**                                         | yes, via the tool                              |
| **Can a subagent use it**    | yes                                                   | yes                                                | yes                                            | yes                                    | n/a                                            | **no** — `DELEGATED_CALLER`                    |
| **Fails how when absent**    | section omitted                                       | provider returns `''` → contributes nothing        | no catalog entry                               | `skill` tool errors "unknown"          | no `/` entry                                   | throws `NO_PROVIDER`                           |

**What each surface is actually for.** The two prompt surfaces are for facts
that must be true _before_ the model acts. The skill is for reference the model
fetches _when_ it acts. The command is for decisions the _human_ makes. The
question is for decisions the _model_ cannot make alone.

---

## 5. What I could not determine

| Claim                                                                                                                           | Status                                                                                                                                                                                                                                                                                                                   | What would settle it                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A plugin-registered runtime skill actually appears in a preset agent's `<available_skills>`                                     | **UNVERIFIED** — the layer merge is documented (`dsh-web-app/cordis.patch.yml:474-488`) but not exercised                                                                                                                                                                                                                | mount a probe `register()` and read the first request header          |
| A Client question card renders for a request with `wait: {callId}` supplied by a plugin rather than by `dsh-tool-ask-user`      | **UNVERIFIED**                                                                                                                                                                                                                                                                                                           | the same probe, with a screenshot                                     |
| `ctx.userQuestions.ask()` is reachable from a plugin whose `apply()` runs on the host plane while the answerer is preset-scoped | **UNVERIFIED** — the waterfall is scope-filtered (`dsh-user-questions/lib/types/types.d.ts:141-142`) and a host listener is outside any agent scope                                                                                                                                                                      | probe from a tool body                                                |
| A `tools/pre-execute` `deny` result reaches `tools/post-execute`, where `additionalContexts` could carry a correction           | **UNVERIFIED by execution** — the code path returns `{kind:'post-result'}` (`dsh-tools/lib/index.js:3243-3256`) into `finalizeScheduledExecution`, which always calls `postExecute` (`dsh-tools/lib/index.js:3368`), and the doc comment says only "pipeline failures are already final" (`dsh-tools/lib/index.js:3322`) | add a post-execute listener that logs, then send a denied command     |
| Whether the skill catalog message is shadowed by compaction like other durable context                                          | **UNVERIFIED**                                                                                                                                                                                                                                                                                                           | compact a session with a loaded skill and inspect the surface         |
| The exact token cost of the current ~200-word injection versus a 40-word catalog line                                           | **UNVERIFIED** — no measurement taken                                                                                                                                                                                                                                                                                    | `dsh-token-meter` on two sessions, or read the `request/header` sizes |

**One bonus finding, worth acting on later.** `PostToolDecision` carries
`additionalContexts?: UserMessage[]` (`dsh-tools/lib/types/index.d.ts:420,
431, 469`), which the registry defers into the model context for the next
request (`dsh-tools/lib/index.js:1388`). If a denial does reach post-execute,
that is a **third** teaching channel: the correction rides the exact call it
answers, in the same waterfall, with no prompt real estate. It would not replace
the rule — but it could carry the _specific_ `jj` replacement for the verb that
was just refused, which is currently only in the `reason` string. Flagged, not
recommended, until the path above is verified.

---

## 6. The first change I would make

**Split the 200 words.** Keep the rule and the state exactly where
[22](22-context-injection.md) put them, and move the manual into a
`ctx.skills.register()` runtime skill.

It is the only one of the three that is a strict reduction with no new failure
mode: `ctx.inject(['skills'], …)` makes the registration conditional on the
service being mounted, a duplicate name loses to any project skill, and the
worst case is that the catalog gains one line. The commands and the questions
each need a new user-facing decision to exist before they are worth building;
the skill needs nothing but the manual we have already written.
