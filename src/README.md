# `src/` — module map

Every module below has a real signature and a documented contract. The guard
chain is implemented and tested; `tools.ts` is the remaining piece. Build order
is `docs/24-implementation-plan.md` §4.

| Module           | Responsibility                                          | Spec                                      |
| ---------------- | ------------------------------------------------------- | ----------------------------------------- |
| `index.ts`       | plugin entry: `name`, `inject`, `Config`, `apply()`     | `SPEC.md` §3, `docs/16`                   |
| `config.ts`      | the `Config` schema — every field `.volatile()`         | `SPEC.md` §6, `docs/29` §2                |
| `settings.ts`    | narrows a raw row into `Settings`; permissive by design | `docs/24` §3.2                            |
| `guard-utils.ts` | `isRecord` / `readString`; zero imports                 | —                                         |
| `detect.ts`      | workspace detection + `effectiveCwd`                    | `SPEC.md` §5.1, `docs/13` §1–2            |
| `parse.ts`       | the resolver's **typed public surface**                 | `docs/15` §4, `docs/21`                   |
| `invocation.ts`  | the resolver **engine** — a verbatim port, annotated    | `docs/21`, `scripts/probe-invocation.mjs` |
| `verbs.ts`       | the Git→`jj` table and classification                   | `docs/15`, `docs/25` §2                   |
| `guard.ts`       | the `tools/pre-execute` listener                        | `SPEC.md` §5.2, `docs/31` Q1              |
| `explain.ts`     | the denial's second channel via `tools/post-execute`    | `SPEC.md` §5.2                            |
| `paths.ts`       | destructive-path predicate for `.git` / `.jj`           | `SPEC.md` §5.7, `docs/21` §e              |
| `context.ts`     | `systemPrompt` rule + state                             | `docs/22`, `SPEC.md` §5.9                 |
| `preflight.ts`   | the 14 environment checks at `agent/created`            | `docs/26` Part A                          |
| `hunk.ts`        | the `jj-hunk` bridge                                    | `docs/08`, `docs/24` §3.8                 |
| `tools.ts`       | the eleven first-class tools                            | `docs/18`, `docs/25` §3                   |
| `state.ts`       | the cached per-session workspace state the prompt reads | `docs/22` §2                              |
| `marker.ts`      | the per-project switch, `.dsh-jujutsu.json`             | `docs/29` §3                              |
| `shell.ts`       | `ctx.shell` wrapper + `shellQuote`                      | `docs/24` §1, §3.1                        |
| `errors.ts`      | error codes and `toolError`                             | `docs/26` Part B                          |

## State

**The guard works, and it is verified live.**

Implemented and tested — 200 tests, `pnpm run ci` green:

| Module          | What works                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `invocation.ts` | the ported resolver; corpus test passes (64 commands, **0 false positives**) |
| `parse.ts`      | the typed surface: `Invocation`, `Token`, `tokenize`, narrowing              |
| `messages.ts`   | the 43-row message catalogue transcribed from `docs/25` §2                   |
| `verbs.ts`      | first-match classification, flags-win-over-verb, generic fallback            |
| `paths.ts`      | the destructive-path predicate (`.git` / `.jj` as exact components)          |
| `detect.ts`     | detection that **walks upward**, plus `effectiveCwd`                         |
| `guard.ts`      | the `tools/pre-execute` listener, fail-open, three-term policy read          |
| `explain.ts`    | the denial's second channel; learns an approval                              |
| `bypass.ts`     | the session-scoped remembered grant                                          |
| `context.ts`    | the rule and the state, empty outside a `jj` workspace                       |
| `preflight.ts`  | gathers detection, `@`, and `jj-hunk` at `agent/created`                     |
| `shell.ts`      | the `ctx.shell` wrapper and `shellQuote`                                     |
| `hunk.ts`       | the `jj-hunk` bridge with its pre-checks                                     |
| `tools.ts`      | the eleven `jj` tools, and `buildToolDefinitions` for testing them           |

### Live verification

The plugin was installed into the live `web` profile, exercised, and removed —
`application: applied`, then verified clean (no entry in `dependencies`, none in
`bundle`s, and the one stale symlink `pnpm` left behind removed by hand). Three
cases, run as real `bash` tool calls against real fixture repos:

| Call                                                     | Result                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `git status`, `workdir` = a colocated `jj` repo          | **denied** — `Refused: git status describes a Git working tree that does not exist here. Run: jj status` |
| `git status`, `workdir` = a plain Git repo               | **ran** — the plugin is invisible outside a `jj` workspace                                               |
| `git log`, `workdir` = a **subdirectory** of a `jj` repo | **denied** — the upward walk found the workspace root                                                    |

That third row is the one the first draft got wrong: `jj` works from any
subdirectory, so a detector that only checked the cwd would have said "no
workspace" and let the command through.

### What is verified, and how

| Layer         | Where the evidence is                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| detection     | [`test/detect.test.ts`](../test/detect.test.ts) — **real fixture repos** on disk, including a subdirectory walk-up and a nested repo    |
| the resolver  | [`test/parse.test.ts`](../test/parse.test.ts) — the 64-command corpus, asserting the prototype's exact numbers                          |
| the guard     | [`test/guard.test.ts`](../test/guard.test.ts) — drives `apply()` through a harness double, plus **three live cases** against real repos |
| the injection | [`test/context.test.ts`](../test/context.test.ts) — including that both contributions are empty outside a `jj` workspace                |
| the tools     | [`test/tools.test.ts`](../test/tools.test.ts) — including that **every definition is accepted by the real `defineTool`**                |
| the panel     | [`test/panel.test.ts`](../test/panel.test.ts) — the schema contract, the built-in-only rule, and that no handler is `undefined`         |
| the binaries  | [`test/e2e.test.ts`](../test/e2e.test.ts) — real `jj` and `jj-hunk` through the plugin's own shell contract                             |

Counts are deliberately absent: a table of numbers goes stale the first time
someone adds a test, and did. `test/docs.test.ts` now checks that any count the
documentation _does_ state matches reality.

### One live verification is still pending, and the cause is now proven

The guard is live-verified. The **eleven tools are not** — and the reason is a
harness behaviour, not a bug in this plugin: **a reinstall reloads the patch, not
the code.** Three attempts, all measured:

| Attempt                                                 | Result                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `install_bundle` again, same source                     | `applied` — the patch re-applied, the module stayed cached, the old code kept running |
| Point `main` at a new file (`src/entry.mjs`), reinstall | still `applied`; a diagnostic wrapper that logged on import produced an **empty log** |
| `install_bundle` from a **copy at a second path**       | `restart-required` — `Replaced "…" ("link:…") with "…" from a different source`       |

So confirming the tool registrations needs a **harness restart**, and there is no
in-session workaround. The full write-up is
[`docs/16-package-conventions.md`](../docs/16-package-conventions.md) §"A
reinstall reloads the patch, not the code".

What that cost, and what it fixed: the first live install registered no tools and
said nothing, because `applyTools` read the registry through `ctx.tools` only. It
now reads **either** `ctx.tools` or `ctx.get('tools')`, and `buildToolDefinitions`
is exported so a test validates all eleven against the real `defineTool` without a
live registry. A silent no-op behind a `catch` is the same failure the probe hit
in `docs/35-probe-results-live.md`, and it is the reason that test exists.

### The port is annotated now

`invocation.ts` carried `// @ts-nocheck` longer than anything else here, and the
reason was sound: it is a verbatim port, and annotating it _during_ the port would
have made a corpus failure impossible to attribute. It was annotated afterwards,
as its own pass, with the corpus green before and after — **the same 64 commands,
54 correct, 10 false negatives, 0 false positives, 16 low-confidence**, which is
the evidence that the pass changed types and not behaviour.

`pnpm typecheck` is now clean across all twenty modules, with no pragma anywhere
in `src/`. Three edits were not purely type-level: guards for
`noUncheckedIndexedAccess` on indexed reads that the surrounding code had already
established were in range (`i + 1 < n`, `ci !== -1`, the `for` bound). Each is
behaviourally a no-op, and the corpus is what says so.

## Four invariants that are easy to break

1. **No `node:fs` and no raw `child_process` anywhere in `src/`.** Filesystem
   work goes through `ctx.fs`; processes go through `ctx.shell`. Both are the
   sandbox and policy boundary (`docs/05`, `docs/06`).
2. **`shellQuote` every argument.** `ShellExecRequest` takes a command _string_,
   not an argv array, so quoting is ours to get right.
3. **The guard's body is `try { … } catch { return next(); }`.** A throw there
   becomes a tool error that skips `post-execute` for _every_ call.
4. **The same wrap belongs around `agent/created`** — where a throw fails session
   creation, not one tool call.

## What is deliberately absent

- **No service.** It is a policy plugin: listeners on existing waterfalls, local
  state, decisions the provider enforces (`docs/27` §3).
- **No agent preset.** The plugin is host-plane. A preset would scope it to one
  agent composition, and the guard must apply to every agent in a `jj` workspace.
