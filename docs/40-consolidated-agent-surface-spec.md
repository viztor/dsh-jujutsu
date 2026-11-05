# 40 — Consolidated agent-surface spec and decision record

**Status:** implemented, 2026-11-03. This document is the single normative
record for the agent-facing surface. It consolidates
[38 — multi-agent capacity](38-multi-agent-and-plugin-capacity.md) (safety and
isolation) and [39 — the full agent feature surface](39-jj-agent-feature-plan.md)
(capability map), and it records what is actually in `src/tools.ts` today.

Where the three documents disagree, **this one wins**. The earlier two remain
the rationale and the measurements; this one is the contract.

---

## 1. Decision record

| #       | Decision                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | The `jj` CLI is the engine; native DSH tools are the adapter; skills teach the long tail.                                                             | The CLI is the source of truth and `-T 'json(self)'` already gives structure. A tool earns its schema only when it returns structure the model would mis-parse or enforces a safety check.                                                                                                                                    |
| **D2**  | No MCP server for `jj`.                                                                                                                               | MCP would be a second adapter with its own schemas, process and lifecycle, and it cannot enforce the `tools/pre-execute` Git guard. It is a distribution channel for non-DSH clients, not a feature. Revisit only on a concrete non-DSH client, a shared core, and a non-DSH `jj-hunk` fallback ([36](36-ai-and-jujutsu.md)). |
| **D3**  | Three tool tiers: `minimal` (5), `core` (14), `full` (28, default).                                                                                   | The full surface is worth its schema to a power user; a small model or a tight prompt needs a smaller set. The guard and prompt are unchanged across tiers.                                                                                                                                                                   |
| **D4**  | Every read passes `--ignore-working-copy`.                                                                                                            | A history read must not capture another agent's half-writes or add an operation. `jj util snapshot` behind `jj_status({snapshot:true})` is the one read that writes.                                                                                                                                                          |
| **D5**  | Every commit-rewriting mutation returns `opId`; destructive tools also return `beforeOpId`. Workspace and publish operations return their own result. | The model can roll back one call without a second `jj op log` round trip.                                                                                                                                                                                                                                                     |
| **D6**  | Per-agent isolation is a real jj workspace plus the session `cwd`.                                                                                    | `tools/pre-execute` cannot rewrite arguments (verified in [11](11-verified-dsh-api-contract.md)), so path virtualization is not a hook. `subagent({cwd})` is the supported boundary.                                                                                                                                          |
| **D7**  | `jj_test` uses an ephemeral colocated workspace and CoW-cloned dependencies.                                                                          | `jj run`'s working copies have no `node_modules` and persist under `.jj/run`; a full-suite run needs a real checkout with dependencies.                                                                                                                                                                                       |
| **D8**  | Repair is explicit: no automatic absorb, restore or push.                                                                                             | `jj absorb` rewrites parent commits and leaves new files/ambiguous hunks; auto-restore is destructive and judgement-heavy; publishing leaves the machine.                                                                                                                                                                     |
| **D9**  | Publishing is a separate approval boundary (`publish`: `deny`, `ask`, or `allow`).                                                                    | `jj git push` is the one operation that leaves the machine. `ask` returns a dry-run preview and requires `confirm:true`.                                                                                                                                                                                                      |
| **D10** | Interactive commands stay skills: `arrange`, `diffedit`, `sparse edit`, external `resolve`, `next/prev`.                                              | A TUI in an agent loop hangs rather than fails.                                                                                                                                                                                                                                                                               |
| **D11** | Family tools, not one tool per command.                                                                                                               | `jj_file`, `jj_history`, `jj_op`, `jj_repair`, `jj_workspace`, `jj_publish`, `jj_test` keep the schema bounded.                                                                                                                                                                                                               |
| **D12** | `jj-hunk` is the one documented exception to read purity.                                                                                             | `jj-hunk` has no `--ignore-working-copy`; `jj_hunk_list` snapshots. Run it in the agent's own workspace, never a shared `@`.                                                                                                                                                                                                  |
| **D13** | Workspace ownership is a bookmark convention (`agent/<name>`), not a side database.                                                                   | Bookmarks are visible in `jj log`, survive restarts, and need no plugin storage. `jj_coordinate` reads them.                                                                                                                                                                                                                  |
| **D14** | Grouping is explicit: `jj_coordinate` plans, `jj_group` merges/squashes/bookmarks.                                                                    | The coordinator can suggest a merge of independent heads; the Lead decides and applies it. No automatic rewrite.                                                                                                                                                                                                              |
| **D15** | Multi-agent configuration lives in `agentBookmarkPrefix` and `workspaceRoot`.                                                                         | The ownership convention and workspace placement are per-user/per-repo choices; both are ordinary config fields.                                                                                                                                                                                                              |

---

## 2. The surface

`TOOL_NAMES` in `src/tools.ts` is the authority. Twenty-eight tools:

| #   | Tool            | Tier | Kind       | Backing                                                                                    |
| --- | --------------- | ---- | ---------- | ------------------------------------------------------------------------------------------ |
| 1   | `jj_status`     | core | read       | `jj log`, `jj util snapshot` (opt-in), `jj op log`, `jj resolve --list`, workspace + owner |
| 2   | `jj_log`        | core | read       | `jj log --no-graph -T 'json(self)'`                                                        |
| 3   | `jj_diff`       | core | read       | `jj diff` / `jj interdiff`                                                                 |
| 4   | `jj_op_log`     | core | read       | `jj op log`                                                                                |
| 5   | `jj_new`        | core | write      | `jj new`                                                                                   |
| 6   | `jj_describe`   | core | write      | `jj describe`                                                                              |
| 7   | `jj_squash`     | core | write      | `jj squash`                                                                                |
| 8   | `jj_bookmark`   | core | write      | `jj bookmark`                                                                              |
| 9   | `jj_op_restore` | core | write      | `jj op restore`                                                                            |
| 10  | `jj_hunk_list`  | core | read       | `jj-hunk list`                                                                             |
| 11  | `jj_hunk_apply` | core | write      | `jj-hunk split/commit/squash`                                                              |
| 12  | `jj_workspace`  | core | read/write | `jj workspace list/add/remove/forget/update-stale/root/rename`                             |
| 13  | `jj_test`       | core | verify     | ephemeral workspace; `jj run`; `jj bisect run`                                             |
| 14  | `jj_repair`     | core | write      | `jj undo/redo/absorb/converge`                                                             |
| 15  | `jj_show`       | full | read       | `jj show --summary` + `jj log` + optional `jj diff --git`                                  |
| 16  | `jj_file`       | full | read/write | `jj file list/show/search/annotate/chmod/delete`                                           |
| 17  | `jj_evolog`     | full | read       | `jj evolog --no-graph -T 'json(self)'`                                                     |
| 18  | `jj_commit`     | full | write      | `jj commit` / `jj split`                                                                   |
| 19  | `jj_edit`       | full | write      | `jj edit`                                                                                  |
| 20  | `jj_history`    | full | write      | `jj rebase/duplicate/revert/abandon/restore/metaedit/parallelize/simplify-parents`         |
| 21  | `jj_op`         | full | read/write | `jj op log/show/diff/restore/revert/abandon/integrate`                                     |
| 22  | `jj_publish`    | full | publish    | `jj git push/fetch`, `jj tag list/set/delete/track/untrack`                                |
| 23  | `jj_fix`        | full | write      | `jj fix` (requires `fix.tools`)                                                            |
| 24  | `jj_sparse`     | full | write      | `jj sparse list/set/reset`                                                                 |
| 25  | `jj_doctor`     | full | read       | `jj --version`, config, workspaces, divergence, sparse, op head                            |
| 26  | `jj_coordinate` | full | read       | workspaces + `agent/*` bookmarks + parent groups; merge plan                               |
| 27  | `jj_group`      | full | write      | `jj new` merge, `jj squash --from/--into`, `jj bookmark set`                               |
| 28  | `jj_sign`       | full | write      | `jj sign` / `jj unsign`                                                                    |

`minimal` is `jj_status`, `jj_log`, `jj_diff`, `jj_new`, `jj_hunk_apply`.
`core` is the first fourteen. `full` is all twenty-eight.

---

## 3. Cross-cutting rules

### 3.1 Read purity

Every read path calls `readOnly()` from `src/shell.ts`, which appends
`--ignore-working-copy`. The exception is `jj util snapshot`, which is reachable
only through `jj_status({snapshot:true})`.

`jj_hunk_list` is the residual exception (D12): `jj-hunk` has no flag. It is a
read that snapshots, so multi-agent sessions must keep it in their own
workspace.

### 3.2 Operation anchors

Every commit-rewriting tool returns `opId`; `jj_history`, `jj_op` and `jj_fix`
also return `beforeOpId`. Workspace and publish operations return their own
result (`jj_workspace add` returns the path; `jj_publish` returns the push
summary). `jj_status` returns the current `opId`, and the prompt carries the
session's `startOp`:

```
Session checkpoint: op <id>. Restore with jj_op_restore <id>.
```

`jj_op_restore` is the blunt restore; `jj_op({action:"revert"})` and
`jj_repair({action:"undo"})` are the surgical ones.

### 3.3 Safety checks

| Check                     | Applies to                                          | Behavior                                                         |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Identity configured       | `jj_new`, `jj_commit`, `jj_hunk_apply` split/commit | `JJ_IDENTITY_UNCONFIGURED`                                       |
| Conflicted `@`            | `jj_new`, `jj_squash`, `jj_hunk_apply`, `jj_commit` | `JJ_CONFLICTS_PRESENT`                                           |
| Immutable commits         | `jj_history`                                        | jj refuses unless `allowImmutable:true`                          |
| Rebase source/destination | `jj_history` rebase                                 | `JJ_REBASE_SOURCE_AMBIGUOUS` / `JJ_REBASE_DESTINATION_AMBIGUOUS` |
| Push approval             | `jj_publish` push                                   | dry-run preview unless `confirm:true` and `publish != "deny"`    |
| Workspace add destination | `jj_workspace` add                                  | jj's own non-empty-destination error, surfaced                   |
| `jj` version              | tool registration                                   | `MINIMUM_JJ` probe                                               |

### 3.4 Output

A tool returns a bare JSON value, or `{error:{code,message,hint?}}`. No new
envelope; the existing contract is preserved. New tools add `opId` /
`beforeOpId` fields to their success values.

### 3.5 Multi-agent coordination

The convention is deliberately made of jj primitives, not a side database:

1. The Lead creates a workspace with `jj_workspace({action:"add", name})`.
   The tool creates a colocated workspace and writes an ownership bookmark
   `agent/<name>` at `<name>@`.
2. The Lead spawns the worker with `subagent({cwd: <workspace path>})`; the
   worker's session cwd is its workspace, so every tool operates there.
3. `jj_coordinate` reads `jj workspace list`, the `agent/*` bookmarks, each
   workspace's `@`/`@-`, and conflict flags. It returns the workspaces, their
   owners, shared-parent groups, merge candidates, a `recommended`
   `{action, revsets}` plan, divergence and warnings.
4. `jj_group` applies the decision: `merge` creates an integration merge of
   the agent heads (`jj new <heads> -m …`, optional `group/<name>` bookmark);
   `stack` chains them linearly (`jj rebase -r <change> -o <previous>`, optional
   bookmark); `squash` folds several changes into one
   (`jj squash --from … --into …`); `bookmark` names a group without rewriting.
5. `jj_workspace({action:"remove"})` snapshots the worker's work before
   deleting the directory; `forget` discards it.
6. Ownership is matched by bookmark **name** (`agent/<workspace>`), not by the
   bookmark's target. The bookmark is created at the workspace's initial `@`
   and does not follow later commits; the name is the stable link.
7. With `coordination: "enforce"`, `jj_edit`, `jj_squash`, `jj_commit` (split),
   `jj_history`, and `jj_group` (stack/squash) refuse to target a change that is
   another workspace's `@`. `advise` returns a warning instead; `off` skips the
   check.
8. `jj_status` reports the current workspace and its owner, and the prompt
   carries the workspace name, so a worker knows which agent it is before it
   acts.

Configuration:

| Setting               | Default  | Effect                                                                     |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `agentBookmarkPrefix` | `agent/` | Prefix for ownership bookmarks; empty disables the convention.             |
| `workspaceRoot`       | `..`     | Where `jj_workspace add` puts a workspace when no path is passed.          |
| `coordination`        | `advise` | `off`, `advise`, or `enforce` when a tool targets another workspace's `@`. |
| `groupDefault`        | `merge`  | What `jj_coordinate` suggests: `merge` or `stack`.                         |

`jj_doctor` reports whether the repo is ready for this: workspace count,
ownership bookmarks, `snapshot.auto-update-stale`, `max-new-file-size`,
`git.colocate`, divergence, sparse patterns, op-log head, and warnings.

---

## 4. What shipped

### P0 — safety

- `readOnly()` helper; `--ignore-working-copy` on `jj_status`, `jj_log`,
  `jj_diff`, `jj_op_log`, `conflictOf`, `identityConfigured`, `hunk.ts`'s
  change-id lookup, and every new read tool.
- `jj_status` now returns `opId`, `divergent`, `conflicts`, and
  `snapshot:true`; the default does not snapshot.
- `startOp` captured at `agent/created` and rendered in the prompt.
- Guard: `git worktree add` → `jj workspace add --colocate`; `git worktree list`
  → `jj workspace list`; denial copy and docs/15/docs/25 updated.
- Skill card updated for the new surface and read purity.

### P1/P2 — inspection, authoring, surgery, recovery

- `jj_show`, `jj_file`, `jj_evolog`, `jj_commit` (commit/split), `jj_edit`.
- `jj_history` (rebase/duplicate/revert/abandon/restore/metaedit).
- `jj_op` (log/show/diff/restore/revert/abandon/integrate).
- interdiff mode on `jj_diff`; conflict paths and divergence on `jj_status`.

### P3/P4 — verification, publishing, workspaces, coordination

- `jj_workspace` (list/add/remove/forget/update-stale/root/rename) with the
  `agent/<name>` ownership bookmark.
- `jj_test` (ephemeral test, `jj run`, `jj bisect run`).
- `jj_repair` (undo/redo/absorb/converge); `jj_history` also exposes
  `parallelize` and `simplify-parents`.
- `jj_publish` (push/fetch/tag-list/tag-set/tag-delete) with the `publish`
  setting.
- `jj_fix`, `jj_sparse`.
- `jj_coordinate` (workspace/owner/parent plan), `jj_group`
  (merge/squash/stack/bookmark), `jj_doctor` (readiness report), `jj_sign`
  (sign/unsign).
- Config: `toolset`, `verifyCloneDirs`, `publish`, `agentBookmarkPrefix`,
  `workspaceRoot`, `coordination`, `groupDefault`; panel and README updated.

### Verification

- Unit tests: tool registration, tiers, bookmark flags, parsing, identity,
  denial copy, panel/schema consistency.
- Real-`jj` tests: the original e2e suite, `test/agent-surface.test.ts`
  (read purity, snapshot checkpoint, workspace add/list/forget/remove,
  show/file/evolog, op log, tag set/list/delete, converge, commit, edit,
  history abandon, `jj_test` test/run cleanup), and
  `test/coordination.test.ts` (ownership bookmarks, per-workspace commits,
  `jj_coordinate`, `jj_group merge`, `jj_group stack`, ownership enforcement,
  `jj_doctor`, `jj_sign` failure path).
- `pnpm build` and `pnpm test` are the gate; the test count is kept in sync by
  `test/docs.test.ts`.

---

## 5. Known gaps and follow-ups

| Gap                                                                                 | Impact                                                                     | Next step                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `jj_test deps:"install"` runs `pnpm install` inside the session sandbox.            | A repo whose pnpm store is outside `workspace-write` can fail the install. | The tool returns the install output; document the escalation requirement in its description. |
| `jj_fix` / `jj_sparse` are registered even when unconfigured.                       | A call can fail with jj's own error rather than a typed `NOT_CONFIGURED`.  | Metadata says they require config; a future conditional-registration pass can hide them.     |
| `jj_sign` / `jj_unsign` are exposed as `jj_sign`, but signing requires repo config. | A call fails with jj's own error when no backend is configured.            | The description says so; add a typed hint if users hit it often.                             |
| `jj next/prev` are skill-only.                                                      | The model shells out for graph navigation.                                 | Keep as skill recipes; no schema spend.                                                      |
| `docs/18` and `docs/25` are historical.                                             | Their bodies still describe the original eleven-tool surface.              | Both carry a superseded note; this document is authoritative.                                |
| `jj_hunk_list` still snapshots.                                                     | A shared `@` can capture half-writes during hunk listing.                  | Upstream `jj-hunk --ignore-working-copy`; until then, per-agent workspaces.                  |
| `docs/18` and `docs/25` are historical.                                             | Their bodies still describe the original eleven-tool surface.              | Both carry a superseded note; this document is authoritative.                                |
| MCP is not built.                                                                   | No non-DSH client can consume the surface.                                 | Revisit only under D2's three conditions.                                                    |

---

## 6. References

- [11 — verified DSH API contract](11-verified-dsh-api-contract.md)
- [17 — bypass and approval](17-bypass-and-approval.md)
- [18 — tool surface](18-tool-surface.md)
- [25 — prompt copy](25-prompt-copy.md)
- [36 — AI and Jujutsu: why not MCP](36-ai-and-jujutsu.md)
- [38 — multi-agent capacity](38-multi-agent-and-plugin-capacity.md)
- [39 — full agent feature surface](39-jj-agent-feature-plan.md)
- `jj help` for 0.46.0: the installed binary is the source of truth for flags.
