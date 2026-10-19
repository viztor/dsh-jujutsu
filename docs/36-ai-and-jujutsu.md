# 36 — AI and Jujutsu: the runtime skill, and whether to serve MCP

**Your question:** the plugin already teaches the model through the system
prompt. Should it also publish the `jj` surface over MCP?

**Answer in one line:** no — DSH's MCP packages are **consumers**, there is no
seam for a plugin to _serve_ MCP, and the eleven native tools already cover the
same ground in-process. An MCP server would buy portability to non-DSH clients
and cost a second policy surface that cannot enforce the guard.

**Source:** the installed DSH `0.2.1-alpha.5` tree, read from the packages
themselves, plus the position already taken in
[27](27-integration-surfaces.md) §5. Claims that are judgement rather than
measurement are marked in §7.

---

## 1. What this plugin teaches, and where it now lives

Three surfaces, split by _when they must be true_
([28](28-teaching-and-interaction-surfaces.md) §1.5):

| Content                                                         | Home                        | Cost                                            |
| --------------------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| the **rule** — Git is intercepted, use `jj`                     | `systemPrompt.section`      | every assembly, before the first Git command    |
| the **state** — root, layout, `@`, `jj-hunk`, the manual's name | `systemPrompt.context`      | every assembly; re-emitted only when it changes |
| the **manual** — model, ids, bookmarks, op log, verb map        | the `jujutsu` runtime skill | one catalog line; the body loads on demand      |

The manual is now real code, not a promise. `src/skill.ts` exports
`applySkill(ctx, settings)`, which registers through
`ctx.inject(['skills'], …)` — the same degrade-don't-fail shape
`src/context.ts` uses for `systemPrompt` — and `src/index.ts` calls it after
`applyContext`. Before this change `teachSkill` was a **dead setting**: it
appeared in the schema, the panel, `SPEC.md` and the README, and no module ever
read it.

The split is justified by **depth, not tokens**. [32](32-probe-results-teaching.md)
§Q3 measured the shipped injection at 89 words ≈ 138 tokens, of which 38 words
are manual: the catalog line buys back roughly 26 tokens with a short
description, and _costs_ about 20 with a long one. What the skill buys is a body
that is paid only in the sessions that load it — and, because it is not in the
~200-word prompt budget, room to be _useful_ rather than terse.

**The body is a card, not the manual.** `jj help <subcommand>` and
`jj help -k <topic>` are local, free, and always match the installed binary, so
copying flags into the skill pays twice and drifts on the next upgrade. The card
therefore keeps only what the binary cannot answer — the Git-to-`jj` intent map,
the plugin's own eleven tools, and the hunk query language — names `jj help` as
the source of truth for the rest, and measures ~670 words instead of ~1,185
(`test/skill.test.ts` caps it at 800 so it cannot grow back). A skill nobody
notices is a file nobody reads, so the state block carries one pointer line
(`Manual: load the jujutsu skill for the verb map and tool details.`, 13 words);
that is the whole per-request cost of discoverability.

Two design rules follow, and both are in the code:

- **The description is a routing rule.** It is the only signal in
  `<available_skills>` ([28](28-teaching-and-interaction-surfaces.md) §1.3), so
  it names Git and the verbs a user says (`commit`, `branch`, `rebase`, `undo`,
  `push`), and it stays under the 214-character break-even from
  [32 §Q3](32-probe-results-teaching.md) — 206 characters / 33 words today.
- **Registration is global and shadowable.** A repository plugin is a
  host-plane row, so the entry lands in the registry's global layer; a project
  skill of the same name in a nearer layer wins, which is the right default
  ([32](32-probe-results-teaching.md) §Q1).

---

## 2. What the harness actually offers for MCP — and it is consumption

The installed tree contains exactly two MCP packages, and both point **inward**:

| Package                          | Direction    | What it does                                                                                                                                                                                              |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@deepseek-ai/dsh-mcp-client`    | **CONSUMER** | Connects to an external MCP server — a spawned child over stdio, or Streamable HTTP — and registers that server's tools on `ctx.tools` as `mcp__<serverName>__<rawName>`. One plugin instance per server. |
| `@deepseek-ai/dsh-mcp-resources` | **CONSUMER** | The resource half of those connections: registers the three model-facing tools `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, backed by the configured servers.             |

There is **no** `@deepseek-ai/dsh-mcp-server` anywhere in the installed tree, and
no bundle row that hosts one. DSH can consume someone else's MCP server; it has
no seam through which a plugin can _be_ one.

That fixes the question's shape. "Should `dsh-jujutsu` provide MCP?" is not a
choice between two harness features — it is a choice between the eleven
in-process tools (`src/tools.ts`, `TOOL_NAMES`) and a **separate artifact** the
harness does not manage: a server process with its own discovery, release,
versioning and lifecycle. The harness's mount/unmount, HMR and config surfaces
stop at the plugin boundary.

---

## 3. Does [27](27-integration-surfaces.md) §5 still hold?

It said, of the service surface:

> **`mcpResources`.** Exposing `jj` state as an MCP resource is a solution
> looking for a problem while the eleven tools exist.

**Yes, and now for a stronger reason than it gave.** §5 answered the _resource_
question (should jj state be published as an MCP resource) and was right on its
own terms: the eleven tools already return structured JSON, and a resource
would be a second, weaker view of the same data. But the question that matters
now is the _server_ question, and §2 shows it has no DSH seam at all. The
position therefore survives and widens: not only is publishing jj state as a
resource pointless, but there is no supported way for this plugin to publish
anything over MCP in the first place.

---

## 4. The one case where an MCP server would genuinely help

**Portability.** A non-DSH client — Claude Code, another editor, a CI harness —
could drive `jj` through the same eleven verbs, with the same JSON shapes and
the same hunk bridge, instead of each client reimplementing them. That is a real
capability, and it is the only one in this document.

It is also the case the plugin was never built for. `dsh-jujutsu` is a **policy
plugin** ([27](27-integration-surfaces.md) §3): it registers no service, owns no
capability, and exists to constrain and inform the harness's own tools. Its
whole value is the constraint, and §5 is where that value fails to travel.

---

## 5. What serving MCP would cost

Five costs, in the order they bite.

1. **A second policy surface.** The Git refusal is a `tools/pre-execute`
   listener ([27](27-integration-surfaces.md) §1) — a DSH waterfall. MCP has no
   equivalent hook, so a server would re-implement the classification in its own
   handlers. The 43-row verb table ([15](15-verb-mapping.md) §1) and the
   43-row denial catalogue ([25](25-prompt-copy.md) §2) would then exist twice.
   They already disagree in the repository once — [15](15-verb-mapping.md) had
   to be corrected against [25](25-prompt-copy.md) — and that was with one copy.
2. **A second schema to keep true.** [18](18-tool-surface.md) documents the
   implemented surface and records six places the first draft diverged from
   `buildToolDefinitions`. An MCP server needs a twin of every input schema, and
   `src/tools.ts` stays the only place that can be checked against a live
   registry.
3. **No guard integration.** The guard protects **this** harness's tool calls.
   A non-DSH client's own `git commit` never passes through the MCP server; the
   server can refuse only the tools it serves. The headline promise — Git is
   refused inside a Jujutsu workspace — is unenforceable from outside, so the
   portable artifact would be a weaker product wearing the same name.
4. **The install offer has no equivalent.** The `jj-hunk` install prompt is
   `ctx.userQuestions.ask` ([28](28-teaching-and-interaction-surfaces.md) §3), a
   DSH service with a DSH-only failure mode (`NO_PROVIDER`). Outside DSH the
   branch degrades to "return the command", which is a second behaviour with its
   own tests and its own wording.
5. **Everything else is duplicated too.** The `jj` 0.46.0 floor probe, the
   identity check that blocks an unpushable commit, the conflict refusal, the
   broken-`.jj` probe, and the `ErrorCode` taxonomy all live in `src/tools.ts`
   and would need a second home. None of it is MCP-specific; all of it is the
   part that makes the tools trustworthy.

Against that, the benefit is one client population that does not exist yet.

---

## 6. Recommendation

**Do not build an MCP server.** Keep the eleven native tools and the runtime
skill. If a non-DSH client is ever a real requirement, build it as a separate
package that imports a shared core — not as a second surface inside this plugin.

Revisit only when **all three** of these hold:

1. a concrete second client needs the `jj` surface, not a hypothetical one;
2. the verb table, the message catalogue and the hunk query language have been
   extracted into a client-agnostic package that both the DSH tools and the
   server import, so there is exactly one source of truth. Today that core is
   in-process (`src/verbs.ts`, `src/messages.ts`, `src/hunk.ts`) and is not
   published for reuse;
3. the `jj-hunk` install path has a tested non-DSH fallback.

**And one condition that would reverse this immediately:** if DSH gains an MCP
_server_ seam — a plugin that exposes its tools to external clients without
shipping its own process — then cost 5 and most of the lifecycle objection
disappear, and this decision should be taken again. The guard would still not
travel (cost 3), so even then the recommendation is "build it for portability",
not "build it for protection".

---

## 7. Verification status

| Claim                                                                                       | Status                                                                                                                           |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `teachSkill` was dead before this change, and `src/skill.ts` now reads it                   | **VERIFIED** — `grep -rn teachSkill src/` returned only the schema and the settings narrowing                                    |
| The skill registers via `ctx.inject(['skills'], …)` and degrades when the service is absent | **VERIFIED** — the code, plus the test that mounts a harness with no `skills` service                                            |
| The eleven tools already exist in-process                                                   | **VERIFIED** — `TOOL_NAMES` in `src/tools.ts` has eleven entries                                                                 |
| `dsh-mcp-client` is a consumer that registers external tools on `ctx.tools`                 | **VERIFIED** — its module doc: "connects to an external MCP server and registers its tools on `ctx.tools`"                       |
| `dsh-mcp-resources` is a consumer and owns the three resource tools                         | **VERIFIED** — its module doc and `lib/index.js` (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`)      |
| No MCP **server** package exists in the installed tree                                      | **VERIFIED** — the only `dsh-mcp*` packages are the two consumers above                                                          |
| [27](27-integration-surfaces.md) §5's position still holds, and widens to the server case   | **ANALYSIS** — a judgement about this plugin's needs, from the verified facts above                                              |
| A non-DSH client's Git calls would escape any server-side guard                             | **ANALYSIS, by construction** — no shared code path exists between `tools/pre-execute` and an external client                    |
| The cost figures in §5 are complete                                                         | **UNVERIFIED** — no MCP server was built, so no measurement exists; the list is read from the modules a port would have to touch |
