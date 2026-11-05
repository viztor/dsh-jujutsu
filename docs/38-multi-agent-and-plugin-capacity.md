# 38 — Multi-agent capacity: a plan for `dsh-jujutsu` on jj 0.46

**Status:** proposal, 2026-11-02; **implemented** 2026-11-03. The normative
record of what shipped is
[40 — consolidated agent-surface spec](40-consolidated-agent-surface-spec.md).
Grounded in measurements against the installed `jj 0.46.0` and the current plugin
(`0.2.0`), not in the earlier chat answers.

**Reading order.** The latest position is the op-log guidance: the snapshot is
automatic, manual op-id tracking is optional, and the one mandatory habit is
`--ignore-working-copy` on read-only `jj` commands. The earlier test-isolation
and `jj absorb` proposals are treated here as **options to evaluate**, not as
the baseline. Where they conflict with the measured behaviour below, the
measurement wins.

**Next.** The full capability roadmap — every agent-relevant `jj` feature and
what becomes a tool versus a skill — is
[39 — the full agent feature surface](39-jj-agent-feature-plan.md).

**Recommendation in one paragraph.** Ship P0 first: make every read
op-log-neutral and make `jj_status({snapshot:true})` the explicit checkpoint.
Then add `jj_workspace` and give each worker its own workspace through
`subagent({cwd})`; that is the only isolation the DSH contract supports without
a custom filesystem provider. Add `jj_test` for full-suite verification in an
ephemeral workspace with a CoW-cloned `node_modules`. Keep `jj absorb` and
`jj converge` as explicit repair tools for the shared mega-merge mode, never as
automatic post-turn hooks. Reject the whole-repo `cp -cR` recipe and the
pre-execute path-rewriting idea: both are measured as broken or unsupported.

---

## 1. What the latest guidance actually changes

| Claim                                                       | Verdict for this repo                                                                                                                                               | Consequence                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Every `jj` command snapshots the working copy by default    | **True.** `jj status`, `jj log`, `jj diff`, `jj op log` all write an operation when the disk changed.                                                               | The plugin's read tools can mutate the repo on any call.                                                             |
| `--ignore-working-copy` stops a read from snapshotting      | **True.** Measured: a new untracked file was not captured by `jj status --ignore-working-copy` or `jj workspace list --ignore-working-copy`.                        | Every read path should pass it.                                                                                      |
| `--at-op` implies `--ignore-working-copy`                   | **True** per `jj --help`.                                                                                                                                           | Useful for inspecting a past operation without touching the working copy.                                            |
| `snapshot.auto-update-stale` exists and defaults to `false` | **True.** `jj config list --include-defaults` reports `false`; `jj workspace update-stale` exists.                                                                  | Recommend `true` for multi-workspace repos; do not write it silently.                                                |
| `jj workspace add --colocate` creates a Git worktree        | **True.** Measured: it printed “Created Git worktree…”, the new workspace has a `.jj/` directory and a `.git` file containing `gitdir: ../repo/.git/worktrees/ws2`. | Per-agent workspaces keep Git tooling working.                                                                       |
| `jj converge --no-interactive` exists                       | **True.** `jj converge --help` documents the non-interactive mode.                                                                                                  | A repair tool can call it safely.                                                                                    |
| `jj undo` refuses cross-workspace operations by default     | **True.** `jj undo --help` documents `--allow-cross-workspace`.                                                                                                     | Expose `jj undo` through `jj_repair` as the safe last-operation undo; keep `jj_op_restore` for explicit checkpoints. |
| `jj util snapshot` exists for explicit checkpoints          | **True.** `jj util snapshot --help` documents the script use case.                                                                                                  | Use it behind an explicit `jj_status({snapshot:true})`, not on every read.                                           |
| Manual op-id tracking is required                           | **False.** The op log is already the recovery path.                                                                                                                 | Capture a start op id as a cheap safety net; do not build a checkpoint daemon.                                       |

The plugin already requires `jj >= 0.46.0` (`src/tools.ts`, `MINIMUM_JJ`), so
there is no upgrade phase. The work is making the plugin _use_ the 0.46
behaviour correctly.

---

## 2. Audit: what the current plugin does

### 2.1 Reads that snapshot

Every `jj_*` read calls `jj` without `--ignore-working-copy`:

| Tool           | Backing command                                    | Snapshots?                                 | Problem in a shared workspace                                                                                                           |
| -------------- | -------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `jj_status`    | `jj log -r '@\|@-'` then `jj log -T conflict -r @` | **Yes** (both commands attempt a snapshot) | Captures another agent's half-written files into `@`; adds an op entry.                                                                 |
| `jj_log`       | `jj log -r <revset>`                               | **Yes**                                    | Same; a pure history read mutates the working copy.                                                                                     |
| `jj_diff`      | `jj diff --summary -r <revset>`                    | **Yes**                                    | Same.                                                                                                                                   |
| `jj_op_log`    | `jj op log`                                        | **Yes**                                    | Reading the recovery log itself adds an operation.                                                                                      |
| `jj_hunk_list` | `jj-hunk list`                                     | **Yes, indirectly**                        | `jj-hunk` has no `--ignore-working-copy` flag; it invokes `jj diff` internally. Cannot be fixed in the plugin without an upstream flag. |

`conflictOf()` and `identityConfigured()` also call `jj log` / `jj config list`
without the flag; they are pre-checks, but they still add snapshots.

### 2.2 Missing capabilities

| Capability          | Today                                                                                      | Consequence                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Workspace lifecycle | None. The guard maps `git worktree add` to `jj workspace add <path>` but there is no tool. | Parallel agents share one `@`; the only isolation is manual shell work.                     |
| Test/verification   | None. The model must shell out to `pnpm test`.                                             | No isolation, no cleanup, no structured exit code.                                          |
| Divergence repair   | None. `jj_converge` is not taught or exposed.                                              | Concurrent edits to one change leave `kxyz/0` and `kxyz/1` unresolved.                      |
| Absorb              | None. The skill mentions `jj absorb` in the verb map but there is no tool.                 | The mega-merge workflow is manual and undocumented.                                         |
| Op checkpoint       | `jj_op_log` + `jj_op_restore` only.                                                        | The model must find an op id after the fact; the prompt has no start-of-session checkpoint. |
| Diagnostics         | Preflight checks only.                                                                     | No single answer to “is this repo configured for multi-agent work?”                         |

### 2.3 The guard and the skill

- `git worktree add` → `jj workspace add <path>`; it should say
  `jj workspace add --colocate <path>` so the Git worktree is explicit.
- `git worktree remove` is not mapped; it should point at
  `jj workspace forget <name>`.
- The `jujutsu` skill teaches the model and the tools, but not
  `--ignore-working-copy`, `jj workspace`, `jj run`, `jj converge`, or
  `jj util snapshot`.

---

## 3. Measured facts that constrain the design

These were run on 2026-11-02 against `jj 0.46.0` in throwaway colocated repos.

| #   | Experiment                                                                                     | Result                                                                                                                           | Design consequence                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `jj workspace add <existing-non-empty-dir>`                                                    | `Error: Destination path exists and is not an empty directory`                                                                   | The “clone the whole repo with `cp -cR`, delete `.jj`, then `jj workspace add`” recipe is **wrong**. Create the workspace first, then clone dependencies into it.          |
| M2  | `jj workspace add <new-dir> --name ws2` in a colocated repo                                    | Creates `.jj/` (directory) and `.git` (file pointing at `../repo/.git/worktrees/ws2`); `jj workspace list` shows both workspaces | Per-agent workspaces are real Git worktrees. Detection already handles the `.git` file shape (`src/detect.ts`).                                                            |
| M3  | Write `dirty.txt`, then `jj status --ignore-working-copy`                                      | `dirty.txt` is absent; no new snapshot                                                                                           | The flag is the correct read-only control.                                                                                                                                 |
| M4  | `jj run --ignore-working-copy --ignore-changes -r <rev> -- sh -c 'pwd; ls'`                    | Runs in `.jj/run/default/1/working_copy`; the primary `@` is unchanged; `dirty.txt` is still unsnapshotted                       | `jj run` is a real isolated-working-copy runner, but it needs `--ignore-working-copy` too. It has no `node_modules` by default.                                            |
| M5  | Merge `@ = new A B`, edit `src/auth/a.ts` and `src/db/b.ts`, add `src/new.ts`, run `jj absorb` | Absorbed into **2 revisions** (`A` and `B`); `src/new.ts` remained in `@`                                                        | Absorb can route across merge parents, but new files and ambiguous hunks stay. It is a shared-workspace mode, not a substitute for isolation.                              |
| M6  | `jj workspace forget ws2` from inside `ws2` with a dirty file                                  | Succeeds with a warning, removes the Git worktree, leaves the directory                                                          | Cleanup must `forget` from the primary workspace and then delete the directory.                                                                                            |
| M7  | `jj-hunk list` on a repo with an unsnapshotted edit                                            | No `--ignore-working-copy` option; the op log gained a `snapshot working copy` entry                                             | Hunk listing remains a snapshotting read. In multi-agent mode, run it in the agent's own workspace, never in a shared `@`.                                                 |
| M8  | DSH `PreToolDecision` union                                                                    | `allow \| deny \| cancel \| ask`; no argument mutation. `tools/execute` can only change `signal`.                                | The “pre-execute path rewriting” proposal is **not implementable** as a plugin hook. The supported isolation boundary is a real workspace plus the session's `header.cwd`. |
| M9  | `spawn_teammate` vs `subagent`                                                                 | `subagent` accepts `cwd`; `spawn_teammate` does not.                                                                             | A Lead can give each worker its own workspace with `subagent({cwd})`. Durable teammates need a workspace path in their prompt or an upstream `cwd` field.                  |

---

## 4. Design decisions

### D1 — Per-agent workspace is the default multi-agent mode

Create one jj workspace per worker, with the worker's session `cwd` set to it.
Every plugin tool already reads `exec.agent.session.header.cwd`, so no path
virtualisation is needed. The Lead's recipe:

1. `jj_workspace({action:"add", name:"agent-a", revset:"<bookmark-or-change>"})`
2. Spawn the worker with `subagent({cwd: <returned path>, ...})`.
3. The worker's `read`, `write`, `edit`, `bash`, and all `jj_*` tools operate
   in that workspace.
4. `jj_workspace({action:"forget", name:"agent-a"})` when the worker is done;
   remove the directory separately.

This is the only clean isolation the DSH contract supports (M8), and it makes
the `snapshot.auto-update-stale` recommendation meaningful.

### D2 — Reads never snapshot; `jj_status({snapshot:true})` is the checkpoint

All read tools pass `--ignore-working-copy`. `jj_status` gains a `snapshot`
boolean, default `false`:

- `snapshot:false` — report the last snapshotted `@`, plus the latest `opId`.
  This is the safe read in a shared workspace.
- `snapshot:true` — run `jj util snapshot` first, then read with
  `--ignore-working-copy`. This is the explicit checkpoint: the model gets a
  fresh `@` and the `opId` to restore to.

`jj_status` also returns `divergent` (change ids from
`jj log -r 'divergent()' --ignore-working-copy`), so the model can see
concurrent-edit damage without a separate tool.

### D3 — Add three tools, not six

The schema budget is real: eleven tools cost roughly 1,000–1,500 tokens on
every request (`docs/18`). Three additions keep the surface at fourteen:

| Tool           | Shape                                                             | Why one tool                                                                                     |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `jj_workspace` | `action: list \| add \| remove \| forget \| update-stale \| root` | One family, one enum; mirrors `jj_bookmark`.                                                     |
| `jj_test`      | `revision?`, `command`, `deps?`, `timeoutMs?`, `keep?`            | One verification workflow; no need for `jj_run` as a separate tool.                              |
| `jj_repair`    | `action: undo \| absorb \| converge`                              | Three recovery verbs, one family; keeps the “fix a broken multi-agent state” story in one place. |

`jj_doctor` is deliberately **not** a tool. Diagnostics belong in preflight
and in `jj_status`; a separate tool would spend schema on a read the model
rarely needs.

### D4 — `jj_test` is an ephemeral workspace with CoW dependencies

Not `jj run` by default, because `jj run`'s working copies do not contain
`node_modules` (M4) and its `.jj/run/...` trees persist. The lifecycle:

1. `jj workspace add <tmp>/dsh-test-<id> --name dsh-test-<id> --colocate -r <rev> --ignore-working-copy`
2. CoW-clone the configured dependency directories from the session workspace
   into the new workspace (`cp -cR` on APFS; `cp -a` fallback).
3. Run the command with `cwd` = the ephemeral workspace.
4. `jj workspace forget dsh-test-<id> --ignore-working-copy` from the primary
   (not `workspace remove`: that snapshots the test artifacts into a commit).
5. `rm -rf` the ephemeral directory.

`jj run --ignore-working-copy --ignore-changes -r <rev> -- <cmd>` stays
documented in the skill as the dependency-free alternative for a stack of
revisions. It is not the default because it cannot run `pnpm test` without a
dependency install.

### D5 — Absorb is explicit, never a post-turn hook

`jj absorb` rewrites parent commits. Automatic absorption after every turn
would rewrite another agent's branch while it is still being edited, and it
silently leaves new files and ambiguous hunks in `@` (M5). Expose it as
`jj_repair({action:"absorb"})` and document the mega-merge recipe:

1. Seed each branch with at least one touch in the files it owns.
2. `jj new A B` to create the shared merge `@`.
3. Agents edit normally; no `jj` commands.
4. At a batch boundary, run `jj_repair({action:"absorb"})`.
5. Inspect `jj diff`; new files remain in `@` and must be assigned explicitly.

This is a **shared-workspace** mode for disjoint modules. It is not the
default, and it does not replace D1.

### D6 — No virtual filesystem, no path rewriting, no daemon

M8 rules out argument rewriting in `tools/pre-execute`. A custom fs/shell
provider could virtualise paths, but that is a capability plugin, not a
policy hook, and it would have to reimplement the sandbox and the read-before-
edit token. A background daemon would add a second writer to the repo and make
the op log harder to reason about. Both are out of scope.

### D7 — The op-log safety net is data, not a new tool

- At `agent/created`, capture the current op id with
  `jj op log --limit 1 --no-graph -T 'id.short()' --ignore-working-copy` and
  store it as `startOp` in `WorkspaceState`.
- Render one line in the prompt context: “Session checkpoint: `op <id>`.
  Restore with `jj_op_restore <id>`.”
- `jj_status` returns the current `opId`, so every explicit snapshot is also
  a checkpoint.
- Do **not** auto-restore. A failed test or a bad turn is a judgement call;
  the model or the Lead decides.

This gives the “instant one-click rollback” value without a checkpoint daemon
or a new tool.

---

## 5. Tool specifications

### 5.1 `jj_workspace`

| Action         | Args                                                      | Backing command                                                                      | Returns                                                    |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `list`         | —                                                         | `jj workspace list --ignore-working-copy`                                            | `[{name, path, changeId, commitId, description, current}]` |
| `add`          | `name?`, `path?`, `revset?`, `colocate?` (default `true`) | `jj workspace add <path> --name <name> --colocate -r <revset> --ignore-working-copy` | `{name, path, changeId, commitId}`                         |
| `remove`       | `name`                                                    | `jj workspace remove <name>`                                                         | `{removed: true}`                                          |
| `forget`       | `name`                                                    | `jj workspace forget <name> --ignore-working-copy`                                   | `{forgotten: true, warning?}`                              |
| `update-stale` | —                                                         | `jj workspace update-stale`                                                          | `{updated: true}`                                          |
| `root`         | —                                                         | `jj workspace root --ignore-working-copy`                                            | `{root}`                                                   |

Rules:

- `add` refuses a path that exists and is non-empty (jj already does; surface
  the error as `JJ_WORKSPACE_DESTINATION_NOT_EMPTY` with a hint).
- `add` defaults the path to `<repo-parent>/<name>` and the name to the
  basename, matching jj.
- `remove` deletes the workspace directory **and snapshots its working-copy
  state into a commit first** — that is jj's contract. Use it for a worker
  workspace whose work should survive; use `forget` + `rm -rf` for an
  ephemeral test workspace whose artifacts should be discarded.
- `forget` refuses the current workspace by comparing the resolved path of
  the named workspace with the session cwd. Forgetting the current workspace
  is legal in jj but leaves the caller in a workspace that no longer exists.
- `update-stale` is for repos that have not set
  `snapshot.auto-update-stale=true`; it is the manual escape hatch.
- `root` is the cheap way for a session to confirm which workspace it is in.

### 5.2 `jj_test`

```
jj_test({
  revision?: string,          // default "@"
  command: string,            // e.g. "pnpm vitest run src/auth"
  deps?: "clone" | "install" | "none",  // default "clone"
  timeoutMs?: number,
  keep?: boolean              // default false
})
```

Returns:

```json
{
  "revision": { "changeId": "...", "commitId": "..." },
  "workspace": { "name": "dsh-test-...", "path": "..." },
  "command": "pnpm vitest run src/auth",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "timedOut": false,
  "durationMs": 1234,
  "cleanedUp": true
}
```

Rules:

- Always creates an ephemeral workspace; never runs in the caller's `@`.
- `deps:"clone"` copies the configured directories (`verify.cloneDirs`,
  default `["node_modules"]`) with `cp -cR` on APFS and `cp -a` otherwise.
  If `pnpm-lock.yaml` differs between the caller's workspace and the target
  revision, return `JJ_TEST_DEPS_STALE` with a hint to use `deps:"install"`
  or update the lockfile. Do not silently run with stale dependencies.
- `deps:"install"` runs `pnpm install --frozen-lockfile` in the ephemeral
  workspace. Under `workspace-write` this may fail because the pnpm store is
  outside the sandbox; the tool returns the install output and a hint rather
  than retrying with escalation.
- A failing test is a normal result (`exitCode` non-zero), not a tool error.
  A workspace-creation failure is a typed tool error.
- Serialize `workspace add` / `workspace forget` per repo with an in-process
  promise chain. Do not hold the lock while the test runs.
- On timeout, kill the process group, then clean up. `keep:true` leaves the
  workspace for debugging and returns `cleanedUp:false`.

### 5.3 `jj_repair`

| Action     | Args                                     | Backing command                                       | Returns                                                           |
| ---------- | ---------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `undo`     | `allowCrossWorkspace?` (default `false`) | `jj undo [--allow-cross-workspace]`                   | `{undone: true, stdout, stderr}`                                  |
| `absorb`   | `from?`, `into?`, `paths?`               | `jj absorb [--from <rev>] [--into <revs>] [paths...]` | `{stdout, stderr, exitCode}`                                      |
| `converge` | `revset?` (default `divergent()`)        | `jj converge --no-interactive -r <revset>`            | `{before: [changeId], after: [changeId], resolved: bool, stdout}` |

Rules:

- `undo` is the safe “undo the last operation in this workspace” verb. It
  refuses a cross-workspace operation by default; `allowCrossWorkspace:true`
  is the explicit opt-in, and the tool description warns that it can undo
  another agent's work.
- `absorb` snapshots the working copy first (it is a mutation; `jj absorb`
  does this by default). It is the one place where a snapshot is intended.
- `converge` reads `divergent()` before and after with
  `--ignore-working-copy`; `resolved` is `after.length === 0`.
- Both return raw `jj` output as a `stdout` string; neither pretends the
  output is structured.

### 5.4 Changes to existing tools

| Tool                                                                 | Change                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jj_status`                                                          | Add `snapshot?: boolean` (default `false`); add `opId`, `divergent` to the result; use `--ignore-working-copy` for both queries; when `snapshot:true`, run `jj util snapshot` first. |
| `jj_log`                                                             | Add `--ignore-working-copy`; optional `atOp?: string` (implies the flag).                                                                                                            |
| `jj_diff`                                                            | Add `--ignore-working-copy`; optional `atOp?: string`.                                                                                                                               |
| `jj_op_log`                                                          | Add `--ignore-working-copy`; optional `atOp?: string`.                                                                                                                               |
| `jj_hunk_list`                                                       | No flag available in `jj-hunk` (M7). Document that it snapshots; use it in the agent's own workspace.                                                                                |
| `jj_new`, `jj_describe`, `jj_squash`, `jj_bookmark`, `jj_op_restore` | No read flag; these are mutations and snapshot by design.                                                                                                                            |

A single helper in `src/shell.ts` should own the rule:

```ts
export function readOnly(args: readonly string[]): string[] {
  return [...args, "--ignore-working-copy"];
}
```

Every read call site goes through it, so a new read tool cannot forget the
flag. `jj util snapshot` is the only read-shaped command allowed to write, and
it is behind `jj_status({snapshot:true})`.

---

## 6. Phases

### P0 — Correctness (1–2 days)

Deliverables:

1. `readOnly()` helper and `--ignore-working-copy` on `jj_status`, `jj_log`,
   `jj_diff`, `jj_op_log`, `conflictOf`, `identityConfigured`, and the
   `hunk.ts` change-id lookup.
2. `jj_status({snapshot:false})` default; `snapshot:true` runs
   `jj util snapshot`; result gains `opId` and `divergent`.
3. `startOp` captured at `agent/created`, rendered in the prompt context.
4. Guard: `git worktree add` → `jj workspace add --colocate <path>`;
   `git worktree remove` → `jj workspace forget <name>`.
5. Skill card: add `--ignore-working-copy`, `jj util snapshot`, and the
   “reads do not snapshot” rule.
6. Tests: two-workspace integration test proving a read in workspace A does
   not capture workspace B's unsnapshotted file; unit tests for the new argv.

Acceptance: `jj_log` in a dirty workspace creates **zero** new op entries and
does not change `@`; `jj_status({snapshot:true})` creates at most one.

### P1 — Workspace isolation (3–5 days)

Deliverables:

1. `jj_workspace` tool with `list`/`add`/`remove`/`forget`/`update-stale`/`root`.
2. `jj_workspace add` returns the absolute path, change id, and commit id.
3. Docs recipe: Lead creates a workspace, spawns `subagent({cwd})`, worker
   operates there, Lead forgets the workspace.
4. Test: workspace add creates `.jj/` + `.git` file; detection works in the
   new workspace; `forget` removes it from `jj workspace list`.

Acceptance: two agents can run `jj_status` in their own workspaces without
seeing each other's unsnapshotted files; `jj workspace list` shows both.

### P2 — Verification (3–5 days)

Deliverables:

1. `jj_test` with ephemeral workspace, CoW dependency clone, cleanup, timeout,
   structured result.
2. `verify.cloneDirs` setting (default `["node_modules"]`).
3. Docs: when to use `jj_test` vs scoped in-place tests vs `jj run`.
4. Tests: a failing test returns `exitCode:1`; the primary `@` is unchanged;
   the workspace is gone from `jj workspace list`; a timeout kills the child.

Acceptance: `jj_test({command:"pnpm vitest run src/auth"})` runs in isolation,
returns the test output, and leaves no workspace behind.

### P3 — Repair and convergence (2–3 days)

Deliverables:

1. `jj_repair({action:"undo"})`, `({action:"absorb"})`, and
   `({action:"converge"})`.
2. `jj_status` `divergent` field; preflight warning when divergence exists.
3. Docs: the mega-merge recipe with the measured limits (M5).
4. Tests: a synthetic two-parent merge absorbs edits into both parents and
   leaves a new file in `@`; a divergent-change fixture converges.

Acceptance: the model can repair a divergent change without shelling out, and
the shared-workspace recipe is documented with its failure modes.

### P4 — Diagnostics and polish (1–2 days)

Deliverables:

1. Preflight diagnostics: workspace count, `snapshot.auto-update-stale`,
   `snapshot.max-new-file-size`, `git.colocate`, op-log head, `jj-hunk`
   version, stale-workspace status.
2. `README` and `docs/18` updated for the new tool count and schema budget.
3. `docs/00-index.md` row for this document.
4. `pnpm ci` green.

Acceptance: a user can see why a repo is not multi-agent-ready from one
preflight block, without a new tool.

**Total:** roughly two weeks of focused work; P0 and P1 are independently
shippable.

---

## 7. Capacity model

### 7.1 Tool surface

| State | Tools                 | Estimated schema cost |
| ----- | --------------------- | --------------------- |
| Today | 11                    | ~1,000–1,500 tokens   |
| P1    | 12 (`+ jj_workspace`) | ~1,150–1,700          |
| P2    | 13 (`+ jj_test`)      | ~1,350–1,950          |
| P3    | 14 (`+ jj_repair`)    | ~1,450–2,100          |

The increase is ~400–600 tokens, or 30–40%. It buys workspace isolation, a
real test runner, and divergence repair. If the budget is tight, ship P0+P1
first (12 tools) and defer P3; `jj absorb` and `jj converge` remain available
through `bash` with the skill card teaching them.

### 7.2 Concurrency

| Workload                                  | Practical ceiling   | Why                                                                |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Scoped unit tests in per-agent workspaces | 8+ agents           | Each run is CPU-bound; no shared `@`, no clone per test.           |
| Full-suite `jj_test` runs                 | 2–4 concurrent      | Each run is a full checkout + test process; disk and CPU dominate. |
| `jj run` across a stack                   | 1–2                 | It creates a working copy per revision; `-j` multiplies processes. |
| Workspace add/forget                      | Serialized per repo | The op-log write is cheap, but the Git worktree creation is not.   |

### 7.3 Disk and op log

- A workspace checkout duplicates tracked files; `node_modules` is CoW-cloned
  and costs ~0 extra bytes on APFS. On non-APFS, `cp -a` duplicates it.
- `jj run` working copies live under `.jj/run/...` and persist by default.
  Use `--clean` or prune them; they are not visible in `jj workspace list`.
- Every workspace add/forget and every explicit snapshot is an operation.
  `jj op abandon` + `jj util gc` is the retention path; no plugin work needed
  until the op log is measured in the hundreds of MB.

---

## 8. Recommended jj config

Put this in the repo's `.jj/repo/config.toml` (or the user's global config):

```toml
[git]
colocate = true # every workspace gets a Git worktree/HEAD

[snapshot]
auto-update-stale = true # another agent's rebase heals this workspace
max-new-file-size = "10MiB" # optional; 1MiB default is safer for build artifacts
```

Notes:

- `git.colocate = true` is already the default in this environment; the
  explicit line documents the intent.
- `snapshot.auto-update-stale = true` is the one setting that changes
  multi-workspace behaviour. The plugin should **recommend** it, not write it.
- `max-new-file-size`: the default is `1MiB`; raising it to `10MiB` lets a
  legitimate large fixture through, at the cost of accidentally snapshotting a
  build artifact. Keep the default unless a repo needs otherwise.

---

## 9. What not to build

| Proposal                                                       | Verdict               | Reason                                                                                                                                                |
| -------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-execute path rewriting / virtual filesystem                | **Reject**            | `PreToolDecision` cannot mutate arguments; `tools/execute` only changes `signal` (M8). A custom fs/shell provider is a different, much larger plugin. |
| `cp -cR` the whole repo, delete `.jj`, then `jj workspace add` | **Reject**            | `jj workspace add` refuses a non-empty destination (M1). Create the workspace first, then CoW-clone `node_modules`.                                   |
| Automatic `jj absorb` after every turn                         | **Reject**            | It rewrites parent commits and leaves new files/ambiguous hunks in `@` (M5); it can race another agent's edits. Make it explicit.                     |
| `jj run` as the default test runner                            | **Reject as default** | Its working copies have no `node_modules` (M4) and persist under `.jj/run`. Keep it for dependency-free checks.                                       |
| Automatic `jj op restore` on a failed turn                     | **Reject**            | Destructive and judgement-heavy; expose the checkpoint and let the model/Lead decide.                                                                 |
| Background daemon that watches and absorbs                     | **Reject**            | A second writer complicates the op log and can capture half-writes; DSH's lifecycle hooks are per-session.                                            |
| `jj_doctor` as a tool                                          | **Defer**             | Diagnostics fit preflight and `jj_status`; a separate tool spends schema for a rare read.                                                             |

---

## 10. Open questions

1. **`jj_status` default in single-agent mode.** Should `snapshot` default to
   `true` when `jj workspace list` shows one workspace, and `false` when it
   shows more? Auto-detection is tempting but unreliable (another agent can
   share the same workspace). A `readSnapshot: "auto" | "always" | "never"`
   setting may be cleaner. Default: `false`; the model passes `true` when it
   needs a checkpoint.
2. **`jj_test` dependency install under the sandbox.** `pnpm install` writes
   the shared store outside `workspace-write`; the tool should not escalate on
   its own. Confirm whether the harness's approval channel can grant the
   install, or whether the user must run it.
3. **`jj_workspace add` and `node_modules`.** Should the generic workspace tool
   clone dependencies, or only `jj_test`? Cloning in `add` makes a new agent
   workspace immediately usable; it also makes `add` slower and couples it to
   the Node ecosystem. Recommendation: `jj_test` only; document a `cp -cR`
   one-liner for manual workspaces.
4. **Shell `jj` reads.** Should the guard refuse `jj log`/`jj diff` in `bash`
   without `--ignore-working-copy`, or only teach the flag? A `jjReadOnly`
   setting (`off`/`advise`/`deny`) is the natural extension of the guard, but
   it costs one extra model call per read. Recommendation: start with the
   skill card and the plugin's own tools; add the guard only if users report
   accidental snapshots.
5. **`jj-hunk` upstream.** `jj-hunk` has no `--ignore-working-copy` (M7).
   A patch upstream would make `jj_hunk_list` op-log-neutral; until then,
   document the limitation.

---

## 11. Acceptance criteria

A change is done when all of these hold:

1. **Read purity.** In a repo with two workspaces, a `jj_log` / `jj_diff` /
   `jj_op_log` call in workspace A creates zero new operations and does not
   capture workspace B's unsnapshotted file.
2. **Checkpoint.** `jj_status({snapshot:true})` creates at most one operation
   and returns an `opId`; `jj_op_restore(opId)` restores the exact state.
3. **Workspace lifecycle.** `jj_workspace add` creates a colocated workspace
   with `.jj/` and a `.git` file; `jj workspace list` shows it; `forget`
   removes it; detection works inside it.
4. **Test isolation.** `jj_test` runs a failing command, returns `exitCode:1`
   with stdout/stderr, cleans up the workspace, and leaves the caller's `@`
   unchanged.
5. **Repair.** `jj_repair absorb` in a two-parent merge moves edits into both
   parents and leaves a new file in `@`; `jj_repair converge` reduces
   `divergent()` to empty on a synthetic, auto-solvable divergence fixture;
   `jj_repair undo` refuses a cross-workspace operation unless
   `allowCrossWorkspace:true`.
6. **Regression.** `pnpm ci` passes; the existing 11 tools keep their
   behaviour except for the documented `jj_status` additions.

---

## 12. References

- [11 — verified DSH API contract](11-verified-dsh-api-contract.md): the
  `PreToolDecision` union and why a pre-execute hook cannot rewrite arguments.
- [18 — tool surface](18-tool-surface.md): the schema budget and the
  one-tool-per-family rule.
- [27 — integration surfaces](27-integration-surfaces.md): `tools/pre-execute`,
  `tools/post-execute`, `agent/created`, `agent/turn-stopping`.
- [30 — lifecycle](30-lifecycle-and-observability-surfaces.md): the
  `agent/turn-stopping` seam and why it is not a denial channel.
- [36 — AI and Jujutsu](36-ai-and-jujutsu.md): why the surface is native tools
  plus a guard, not MCP.
- `jj help workspace add`, `jj help run`, `jj help absorb`, `jj help converge`,
  `jj help util snapshot`, `jj help undo` — the installed 0.46.0 is the source
  of truth for flags.
