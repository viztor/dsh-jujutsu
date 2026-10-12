# 24 — Implementation plan

**Status:** the bridge from spec to code. Nothing here is built yet.
Every harness interface below was read from the installed `0.2.0-rc.2` source;
package-relative citations.

## 1. The verified interfaces this builds on

| Need                     | Interface                                                                       | Source                                       |
| ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Intercept a tool call    | `ctx.on('tools/pre-execute', async (exec, next) => PreToolDecision)`            | `dsh-tools/lib/types/index.d.ts:47`          |
| Deny / ask / allow       | `{kind:'deny',reason}` · `{kind:'ask',reason,displayReason}` · `{kind:'allow'}` | same, `:445`                                 |
| The call record          | `exec.name`, `exec.arguments`, `exec.agent`, `exec.signal`                      | same, `:216`                                 |
| Workspace root           | `exec.agent?.session.header.cwd`                                                | `dsh-tool-fs/lib/types/session-cwd`          |
| Read the filesystem      | `ctx.fs.stat(target)` → `FsInfo \| undefined` (**no `exists`**)                 | `dsh-fs/lib/types/index.d.ts:138`            |
| Run a process            | `await (await ctx.shell.execute(ctx.shell.resolve(req))).result()`              | `dsh-tool-bash/lib/index.js:683`             |
| Register a tool          | `ctx.tools.register(defineTool({name, description, parameters}))`               | `dsh-tool-bash/lib/index.js:487`, `:698`     |
| Inject context           | `ctx.inject(['systemPrompt'], s => s.systemPrompt.context({…}))`                | `dsh-user-approval/lib/index.js:78`          |
| Read the approval policy | `ctx.get('approval')?.overrideOf(session)`                                      | `dsh-user-approval/lib/types/index.d.ts:149` |

### Three consequences that shape the code

**`ctx.shell` takes a command string, not an argv array.** `ShellExecRequest`
declares `command: string` and nothing else for the program. There is no
`execFile` path. Every `jj` invocation must therefore be **shell-quoted by us**,
and `shellQuote()` is load-bearing: a revset, a commit message, or a path with a
quote in it must not be able to break out. Single-quote escaping
(`'` → `'\''`) and nothing clever.

**`result()` is the only way to get output**, and it returns:

```ts
interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: CollectedOutput; // { text, truncated, spillPath? }
  stderr: CollectedOutput;
  sandbox?: ShellSandboxInfo;
}
```

Non-zero exits resolve, they do not reject. `timedOut`/`aborted` are
first-cause classified and mutually exclusive. A `truncated` stream means
`text` is the **tail** — for a JSON parse this must be a hard error, not a
best-effort parse.

**`bash` has a `workdir` parameter.** This corrects an earlier assumption in
this repo. Its own description tells the model to _"pass `workdir` instead of
using `cd`"_, and the tool resolves it with `resolveWorkdir(modelWorkdir, exec,
policyWorkspaceRoot)` (`dsh-tool-bash/lib/index.js:293`) — where **a resolved
sandbox-policy root wins over the session cwd**, and a relative workdir is
joined by string concatenation. **Detection must mirror it:**

```ts
const sessionCwd = policyWorkspaceRoot ?? exec.agent?.session.header.cwd;
const cwd =
  exec.arguments.workdir === undefined
    ? sessionCwd
    : isAbsolute(exec.arguments.workdir)
      ? exec.arguments.workdir
      : resolve(sessionCwd ?? "", exec.arguments.workdir);
```

Skipping this means a `git` command in a _different_ `jj` repo slips through,
and — worse — a Git command in a non-`jj` sibling gets refused because the
session root is a `jj` repo.

**Settled:** a `tools/pre-execute` listener can obtain the same
`policyWorkspaceRoot` the bash tool computes, from `ctx.get('sandboxPolicy')` —
both sides call the same pure `resolve({session: exec.agent.session})`. Better
still, `resolve` derives `workspaceRoot` from `session.header.cwd` **and nothing
else** whenever the session has a cwd, so the two agree by construction in every
ordinary session. The service is load-bearing only for a session with **no**
`header.cwd`. One residual to mirror: gate on `ctx.shell.sandboxMode ===
undefined`, the same way the bash tool does. Evidence:
[29](29-state-config-and-sandbox-surfaces.md) §3.

## 2. Package layout

```
src/
  index.ts        plugin entry: name, inject, Config, apply()
  config.ts       the schemastery Config schema
  detect.ts       workspace detection + cache
  parse.ts        invocation resolver (port of scripts/probe-invocation.mjs)
  verbs.ts        Git → jj table, classification, message lookup
  messages.ts     the literal copy (docs/25-prompt-copy.md)
  guard.ts        the tools/pre-execute listener
  paths.ts        destructive-path predicate (.git / .jj)
  context.ts      systemPrompt section + runtime context
  shell.ts        ctx.shell wrapper, shellQuote, runJj, runJjHunk
  jj.ts           typed reads over jj
  hunk.ts         the jj-hunk bridge
  tools.ts        the ten defineTool registrations
  errors.ts       error codes and the {error:{code,message,hint}} shape
  preflight.ts    environment checks (docs/26)
test/
```

## 3. Modules

### 3.1 `shell.ts`

```ts
export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function shellQuote(arg: string): string;

export async function run(
  ctx: Context,
  argv: readonly [string, ...string[]],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<RunResult>;
```

`run` joins `argv.map(shellQuote)` with spaces, calls `resolve` then `execute`
then `result()`, and maps the outcome. It never throws on a non-zero exit — the
caller decides. It throws only on a spawn failure.

`runJj(ctx, args, opts)` and `runJjHunk(ctx, args, opts)` are thin wrappers that
prepend the configured binary path.

### 3.2 `detect.ts`

```ts
export type WorkspaceKind = "jj-native" | "jj-colocated" | "none";

export interface Detection {
  kind: WorkspaceKind;
  root: string;
  hasGitDir: boolean;
  hasGitFile: boolean; // secondary workspace / git worktree
}

export async function detect(ctx: Context, root: string): Promise<Detection>;
```

`stat(join(root, '.jj'))` decides `jj` vs `none`; `stat(join(root, '.git'))`
distinguishes native from colocated. Both are `ctx.fs.stat`, never `node:fs`.

Cache: `Map<string, Detection>`, invalidated when a `bash` call containing
`jj git init` or `jj workspace add` is allowed, and at session start.

### 3.3 `parse.ts`

A direct port of `scripts/probe-invocation.mjs` (already written and exercised
against a 64-command corpus). Keep its contract:

```ts
export interface Invocation {
  programs: string[];
  gitInvocations: string[];
  confidence: "high" | "low";
  notes: string[];
}
export function classifyInvocation(command: string): Invocation;
```

Port, do not rewrite. The corpus in `docs/21` is the regression suite, and the
probe's honesty about its own limits (low confidence instead of guessing) is the
part worth preserving.

### 3.4 `verbs.ts`

```ts
export type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; display: string }
  | { kind: "ask"; reason: string; display: string }
  | { kind: "block"; reason: string }; // destructive path

export function classifyGitInvocation(
  invocation: Invocation,
  policy: { readOnlyGit: "deny" | "ask" | "allow" },
): Verdict;
```

Three tiers, in order — **exact row → verb family → generic fallback** — so an
unrecognised `git` subcommand can never fall through to allow (R3–R5). Flags win
over the verb (R6). Table-driven; one test per row of `docs/20` §d.

### 3.5 `paths.ts`

```ts
export function destructiveTargetsVcs(command: string): "git" | "jj" | "unresolvable" | undefined;
```

Separate predicate, separate message. Triggers only on a destructive verb whose
**resolved path argument names the exact component** `.git` or `.jj`.
`.gitignore` / `.gitattributes` / `.gitkeep` / `.github/` are not triggers. A
path containing an expansion returns `'unresolvable'` → **ask, never allow**.

### 3.6 `guard.ts`

```ts
export function applyGuard(ctx: Context, config: Config): void;
```

The listener, in order:

1. `exec.name === 'bash'` → parse + destructive-path check.
2. `exec.name` in `{read, write, edit}` → path check against `.jj/**` / `.git/**`.
3. Anything else → `next()`.

Then resolve the effective cwd (§1), detect, and on a `jj` workspace consult
`verbs.classify…`. Before returning `ask`, read the approval policy: under
`never`, return our own `deny` so the message survives (the harness substitutes
"The user rejected tool bash" otherwise).

**The whole body is wrapped in `try { … } catch { return next(); }`.** Verified:
a throwing `tools/pre-execute` listener is caught by the registry and converted
into a **tool error** (`dsh-tools/lib/index.js:3221-3225` → `:3198`), so one
detector bug would break _every_ `bash` call rather than the one being
classified. This is the single most important line of defensive code in the
plugin.

Also verified: `info.code` on a `deny` is **not model-visible** — only `reason`
is. Every reason must be self-contained.

### 3.7 `context.ts`

Two registrations, per [22](22-context-injection.md): a `section` at
`getSectionOrder('TOOL_BASH')` and a `context` at order `130`. Both providers
return `''` outside a `jj` workspace. Copy comes from
[docs/25](25-prompt-copy.md).

### 3.8 `hunk.ts`

```ts
export interface HunkSelection {
  query?: string;
  spec?: unknown;
}
export async function listHunks(ctx, opts): Promise<HunkListResult>;
export async function applyHunks(ctx, mode, selection, opts): Promise<ApplyResult>;
```

Rules, all measured:

- `--query` is the primary input. **Never accept hunk IDs across turns** — they
  regenerate on any edit.
- Never combine `--query` with `--include` / `--exclude` / `--files`; scope goes
  inside the query via `path:`.
- Write any spec file **outside** the working copy — a spec inside the repo
  invalidates its own IDs and produces an empty commit.
- Parse `--format json`; never scrape the text format.
- **Never trust the exit code.** `jj-hunk` exits 0 on four distinct failures
  ([26](26-preflight-and-error-taxonomy.md) §B.1): empty `--query` →
  `{"files":[]}`; empty query on `split` → silent no-op; **stale spec → an empty
  commit** carrying the user's message with every change left uncommitted;
  multi-rev revset → silently diffs the merged set. Each needs a plugin-side
  pre-check. `HUNK_SPEC_STALE` cannot be inferred from the exit code at all.

### 3.9 `tools.ts`

Ten `ctx.tools.register(defineTool({name, description, parameters}))` calls.
Parameters are plain JSON-schema-ish objects (`{type, description, enum?}`),
matching the bash tool. Every tool returns JSON; mutating tools echo the
resulting working-copy state.

## 4. Build order

| Milestone               | Delivers                                                                  | Proves                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 — spike**          | a throwaway plugin that returns `{kind:'ask'}` for one command            | **the one unverified link**: does an ask reach a UI and come back as `allowed-once`? Everything in [17](17-bypass-and-approval.md) rests on it. |
| **M1 — detect + parse** | `detect.ts`, `parse.ts` ported, unit-tested against the 64-command corpus | the corpus still passes after the port                                                                                                          |
| **M2 — guard**          | `verbs.ts`, `guard.ts`, `messages.ts`, fail-open wiring                   | the behaviour matrix in `SPEC.md` §7                                                                                                            |
| **M3 — paths**          | `paths.ts`, write protection                                              | `rm -rf .git` is refused; `.gitignore` is not                                                                                                   |
| **M4 — context**        | `context.ts`                                                              | the injected text actually reaches the model, and is absent outside a `jj` repo                                                                 |
| **M5 — tools + hunk**   | `shell.ts`, `jj.ts`, `hunk.ts`, `tools.ts`                                | a real split round-trips on the `jj-with-changes` fixture                                                                                       |
| **M6 — preflight**      | `preflight.ts`, `errors.ts`                                               | every `docs/26` failure mode produces its message                                                                                               |

M0 is first because it is the only step whose outcome could invalidate a design
decision. M5 is last because it is the largest surface and the least likely to
surprise.

## 5. Test mapping

| Module      | Layer       | Fixture                                             |
| ----------- | ----------- | --------------------------------------------------- |
| `parse.ts`  | unit        | none — the 64-command corpus                        |
| `verbs.ts`  | unit        | none — the 104-row table                            |
| `guard.ts`  | unit        | fake `exec`, stubbed detector                       |
| `detect.ts` | integration | all seven fixtures                                  |
| `paths.ts`  | integration | `jj-colocated`                                      |
| `hunk.ts`   | integration | `jj-with-changes`                                   |
| `tools.ts`  | integration | `jj-with-changes`, `jj-native`                      |
| preflight   | integration | `jj-native` (no `.git`), plus a broken-repo fixture |

`test/fixtures/build-fixtures.sh` already builds all seven and self-verifies;
it is the entry point for every integration layer.

## 6. Unknowns to settle during the build

| #   | Unknown                                                                                                   | How to settle                                                |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Does `{kind:'ask'}` reach a UI and return `allowed-once`?                                                 | M0 spike                                                     |
| 2   | Is `exec.arguments.workdir` always a string when present, and relative to the session cwd?                | read the bash tool's handler; confirm with a live call       |
| 3   | Does `ctx.fs.stat` resolve a path relative to the workspace, or must we join the root ourselves?          | read `dsh-fs` `stat` + `resolve`                             |
| 4   | Are tool parameters validated before `tools/pre-execute`, or only inside the tool body?                   | affects whether `exec.arguments` is trustworthy in the guard |
| 5   | The exact `defineTool` return contract and disposer                                                       | `dsh-tool-bash/lib/index.js:698`                             |
| 6   | Whether `inject: ['tools','fs','shell','systemPrompt']` is sufficient, or `approval` must be declared too | `ctx.get('approval')` is optional by design; confirm         |

**#7 is settled — see §1.** The guard _can_ read the same `policyWorkspaceRoot`
the bash tool computes, and in practice it does not need to: `SandboxPolicyService.resolve`
derives `workspaceRoot` from `session.header.cwd` and nothing else whenever the
session has a cwd. Evidence: [29](29-state-config-and-sandbox-surfaces.md) §3.

## 7. Definition of done

The seven acceptance criteria in
[`docs/12`](12-risks-and-open-questions.md) §H, plus:

- the 64-command corpus and the 104-row table both pass as unit tests;
- every message is ≤240 characters and names a command verified to exist in
  `jj` 0.46;
- no `node:fs` and no raw `child_process` anywhere in `src/`;
- the plugin is invisible in `plain-git` and `not-a-repo` — asserted, not
  assumed.
