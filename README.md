# dsh-jujutsu

Working notes for a DeepSeek Harness (DSH) plugin that makes the harness
**jj-native** — Jujutsu (`jj`) as the version-control surface, with `jj-hunk`
for non-interactive, hunk-level change distribution — instead of Git.

The plugin is **implemented**: 20 modules under `src/`, 57 tests, and a guard that
has been verified running inside the harness. This repo also holds the
[research digest](research/digest.md) and the [topic split](docs/00-index.md) of
the conversation that seeded the design.

## Where this came from

The design conversation happened in a **Google AI Mode** thread, shared as a
public link. Google blocks automated access to `share.google/aimode/*` from
datacentre IPs, so the page was rendered through an anti-bot scraper (Context.dev,
residential proxy).

**The transcript is not kept verbatim.** It was distilled into
[`research/digest.md`](research/digest.md) — every durable fact, command, number
and decision from the thread, organised by topic — and the raw scrape was then
deleted. It carried a personal share link and a private conversation, and a
verbatim copy is both a liability and a *worse* reference than a digest: 264K of
Q&A against a few pages of the facts that survived scrutiny.

- Research digest: [`research/digest.md`](research/digest.md)
- Topic split: [`docs/00-index.md`](docs/00-index.md)

## What's here

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | The build specification: scope, architecture, components, config, behaviour matrix, failure modes, testing, rollout. |
| [`research/digest.md`](research/digest.md) | The durable record of the source thread: facts, commands, numbers and decisions, by topic. |
| [`src/README.md`](src/README.md) | The module map, what is verified and how, and what is still open. |
| [`docs/00-index.md`](docs/00-index.md) | The topic split of the source conversation, plus the decision index. |
| [`docs/11-verified-dsh-api-contract.md`](docs/11-verified-dsh-api-contract.md) | The harness seams, read from the installed `0.2.0-rc.2` source. |
| [`docs/13-empirical-verification.md`](docs/13-empirical-verification.md) | What was measured with real `jj` 0.46.0 and `jj-hunk` 0.5.1. |
| [`docs/14-decision-log.md`](docs/14-decision-log.md) | The eight decisions and the fourteen resolutions, with their evidence. |
| [`docs/15-verb-mapping.md`](docs/15-verb-mapping.md) | The Git → `jj` denial-message table. |
| [`docs/22-context-injection.md`](docs/22-context-injection.md) | The injection seam, and what the model is told about `jj`. |
| [`docs/24-implementation-plan.md`](docs/24-implementation-plan.md) | Module-by-module interfaces and the build order M0–M6. |
| [`docs/27-integration-surfaces.md`](docs/27-integration-surfaces.md) | The whole harness extension map — 90 events, ~95 services. |
| [`docs/34-probe-plan.md`](docs/34-probe-plan.md) | What was open, and how it was closed. |
| [`docs/35-probe-results-live.md`](docs/35-probe-results-live.md) | The live probe: built, installed, exercised, removed. Twelve of fourteen questions closed. |
| [`src/README.md`](src/README.md) | The module map — every module with its signature and the document that specifies it. |

**It works.** The guard, the detection and the injection are implemented and
verified — 57 tests, `pnpm run ci` green, and three live cases run against real
repositories through the harness itself:

| Call | Result |
|---|---|
| `git status` in a colocated `jj` repo | **refused** — `Refused: git status describes a Git working tree that does not exist here. Run: jj status` |
| `git status` in a plain Git repo | **ran** — the plugin is invisible outside a `jj` workspace |
| `git log` in a **subdirectory** of a `jj` repo | **refused** — the upward walk found the workspace root |

The eleven `jj` tools are implemented and their definitions validated against the
real `defineTool`; their live registration still needs a harness restart to
confirm. See [`src/README.md`](src/README.md) for what is verified and how.

Local toolchain this project targets: `jj` 0.46.0 (`brew install jj`) and
`jj-hunk` 0.5.1 (`cargo install --git https://github.com/laulauland/jj-hunk jj-hunk`).

## Headline findings

1. **The early turns answer a different question than the one being asked.**
   Turns 1–9 read "jujutsu" as *Jiu-Jitsu, the martial art*, and invent a
   "Jiu-Jitsu domain project" (`jiujitsu.config.json`, `positions.json`,
   `src/techniques/`). Only at turn 10 does the thread switch to **Jujutsu, the
   version-control system**. Any design detail taken from turns 1–9 must be
   re-read with that substitution in mind. See
   [`docs/01-framing-and-intent.md`](docs/01-framing-and-intent.md).

2. **The proposed guard API is wrong for this harness version.** The thread
   uses `ctx.tools.on('tools/pre-execute', …)` and `throw new Error(…)`. The
   real contract is a **waterfall returning a decision object**
   (`{kind:'deny', reason}`), with a dedicated `tools.guard()` for monotonic
   policy and `tools/post-execute` for corrective feedback. See
   [`docs/11-verified-dsh-api-contract.md`](docs/11-verified-dsh-api-contract.md).

3. **There is no git tool to disable.** The thread's "recommended" Option A is
   to disable `@deepseek-ai/dsh-tool-git` in a preset. No such package — and no
   `git` tool name — exists in DSH `0.2.0-rc.2`. Git is reachable only through
   the `bash` tool, so the guard has to target **`bash` argument text**.

4. **The "silent translation layer" is not implementable.** `tools/pre-execute`
   explicitly excludes input rewriting, and the thread's `callContext.bypass(…)`
   does not exist. This is convenient: the design already rejects the silent
   approach (turns 8→9), so the correct mechanism is the loud one.

5. **`jj-hunk` is the right primitive for a headless agent.** Native `jj` wants
   an interactive TUI (`jj split -i`) to split hunks; `jj-hunk` is a
   non-interactive CLI with `json`/`yaml` output, which is what a tool-calling
   agent needs. See [`docs/08-jj-hunk.md`](docs/08-jj-hunk.md).

## The digest

[`research/digest.md`](research/digest.md) is the record of what that research
thread established, written to stand alone. It is **hand-maintained**: the raw
scrape it came from has been deleted, so there is nothing left to regenerate it
from. Treat it as a primary document, not a build product.

## Privacy

The source thread was a personal Google AI Mode share link and the conversation
behind it was private. **The verbatim transcript is not kept.** It was distilled
into [`research/digest.md`](research/digest.md), which carries the technical
record and none of the personal material, and the raw scrape, the cleaned
transcript and the per-turn files were deleted. The digest is safe to publish;
the thread was not.

## Building

```bash
pnpm run build     # tsc -p tsconfig.build.json  ->  lib/
pnpm run ci        # tsc --noEmit + vitest
```

**`lib/` is not optional and not committed.** The published entry is emitted
JavaScript, because Node **refuses to strip types for files under
`node_modules`**:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

That is why the plugin works from a `link:` install and would not work from a
tarball: a link resolves to the working tree (where stripping is allowed), while
a real install lands in `node_modules` (where it is not). Shipping
`main: "src/index.ts"` therefore produces a package that cannot load once
installed — measured, not assumed.

`tsconfig.build.json` emits with `rewriteRelativeImportExtensions`, so the
`./foo.ts` specifiers the source uses become `./foo.js` in the output without a
bundler. `lib/` is gitignored; `files` ships it, and `prepublishOnly` rebuilds
it, so a tarball always carries fresh JavaScript.

### Publishing

```bash
pnpm publish        # prepublishOnly runs the build and the full suite first
```

The package declares the harness packages as **peerDependencies**, matching the
sibling `dsh-tinyfish` convention: the host provides `@deepseek-ai/dsh-tools` and
`@deepseek-ai/dsh-llm`, which the built JavaScript imports at runtime.
`@deepseek-ai/schemastery` is the only true dependency.
