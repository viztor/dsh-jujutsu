# 39 — The full Jujutsu feature surface for an agent workflow

**Status:** proposal, 2026-11-02; **implemented in part** 2026-11-03. The
normative record of what shipped is
[40 — consolidated agent-surface spec](40-consolidated-agent-surface-spec.md).
Builds on [38 — multi-agent capacity](38-multi-agent-and-plugin-capacity.md).
`docs/38` is the safety and isolation prerequisite; this document is the
capability roadmap that sits on top of it.

> **Shipped count.** The implemented `full` tier is **28** tools
> ([40](40-consolidated-agent-surface-spec.md)); this document's 20-tool
> estimate predates the coordination and diagnostics additions (`jj_coordinate`,
> `jj_group`, `jj_doctor`, `jj_sign`).

**Scope.** “All the proper features” does **not** mean a one-to-one wrapper
around every `jj` subcommand. It means every Jujutsu capability an agent
actually needs to do real work, delivered through the right mechanism:

| Mechanism       | Use it for                                                                    | Cost                                   |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| **Tool**        | Structured output, safety checks, high frequency, multi-step operations       | Tool schema on every request           |
| **Skill**       | Simple commands, interactive commands, rare operations, user-configured tools | One catalog line; body loads on demand |
| **Guard**       | Git commands that have a Jujutsu equivalent, or that would corrupt the repo   | Constant, already paid                 |
| **Not exposed** | TUI editors, debug commands, admin-only commands, niche integrations          | Zero                                   |

The rule: **a tool earns its schema only when it returns structure the model
would otherwise mis-parse, or when it enforces a safety invariant the model
would otherwise miss.** Everything else is taught in the skill and run through
`bash`, where the model can read `jj help` and see the real command.

---

## 1. The complete feature map

Every command below is from the installed `jj 0.46.0` (`jj help`). “Delivery”
is the recommended mechanism; “Status” is relative to the current plugin.

### 1.1 Orientation and inspection

| jj feature      | Agent use                                                                 | Delivery                                       | Status                                         | Priority |
| --------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | -------- |
| `status`        | Where am I, what is dirty, am I conflicted                                | `jj_status` tool                               | Exists; needs read-purity + `opId` + conflicts | P0       |
| `log`           | History, change ids, graph shape                                          | `jj_log` tool                                  | Exists; needs `--ignore-working-copy`          | P0       |
| `show`          | One revision's metadata **and** diff                                      | **`jj_show` tool**                             | Missing                                        | P1       |
| `diff`          | What changed between revisions                                            | `jj_diff` tool                                 | Exists; needs read-purity                      | P0       |
| `interdiff`     | “What changed since the last push?” — compares two patches, not two trees | `jj_diff({mode:"interdiff"})` or skill         | Missing                                        | P2       |
| `evolog`        | How a change evolved, including hidden predecessors                       | **`jj_evolog` tool**                           | Missing                                        | P1       |
| `file list`     | Files in a revision without checkout                                      | **`jj_file` action `list`**                    | Missing                                        | P1       |
| `file show`     | File contents at a revision                                               | **`jj_file` action `show`**                    | Missing                                        | P1       |
| `file search`   | Search a revision's tree                                                  | **`jj_file` action `search`**                  | Missing                                        | P1       |
| `file annotate` | Blame / line provenance                                                   | **`jj_file` action `annotate`**                | Missing                                        | P1       |
| `root`          | Which workspace root am I in                                              | `jj_status` or `jj_workspace({action:"root"})` | Missing                                        | P0       |
| `version`       | Capability/version probe                                                  | Preflight only                                 | Exists                                         | —        |

### 1.2 Authoring and navigation

| jj feature      | Agent use                                                              | Delivery                                           | Status                   | Priority |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------- | ------------------------ | -------- |
| `new`           | Start a change on a revision                                           | `jj_new` tool                                      | Exists                   | —        |
| `commit`        | Describe `@` and start the next change; optionally keep selected paths | **`jj_commit` tool**                               | Missing                  | P1       |
| `describe`      | Reword a change                                                        | `jj_describe` tool                                 | Exists                   | —        |
| `edit`          | Resume work on an existing change                                      | **`jj_edit` tool**                                 | Missing                  | P1       |
| `next` / `prev` | Move `@` along the graph                                               | Skill                                              | Missing                  | P4       |
| `squash`        | Fold a change into another                                             | `jj_squash` tool                                   | Exists                   | —        |
| `split`         | Split a change by path or hunk                                         | **`jj_commit({mode:"split"})`** or `jj_hunk_apply` | Partial (`jj-hunk` only) | P1       |
| `absorb`        | Route edits into the ancestor that owns the lines                      | `jj_repair({action:"absorb"})`                     | Missing                  | P0       |
| `duplicate`     | Copy a change elsewhere                                                | `jj_history({action:"duplicate"})`                 | Missing                  | P2       |
| `restore`       | Restore paths from another revision                                    | `jj_history({action:"restore"})`                   | Missing                  | P2       |
| `revert`        | Apply the inverse of a change                                          | `jj_history({action:"revert"})`                    | Missing                  | P2       |
| `abandon`       | Drop a change, rebase descendants                                      | `jj_history({action:"abandon"})`                   | Missing                  | P2       |
| `metaedit`      | Change author/committer metadata                                       | `jj_history({action:"metaedit"})`                  | Missing                  | P2       |
| `diffedit`      | Interactive diff editor                                                | Skill only — interactive                           | —                        | —        |
| `arrange`       | Interactive graph arrangement                                          | Skill only — interactive                           | —                        | —        |

### 1.3 History surgery

| jj feature         | Agent use                       | Delivery                            | Status  | Priority |
| ------------------ | ------------------------------- | ----------------------------------- | ------- | -------- |
| `rebase`           | Move a stack onto a new parent  | **`jj_history({action:"rebase"})`** | Missing | P2       |
| `parallelize`      | Make revisions siblings         | Skill                               | Missing | P4       |
| `simplify-parents` | Remove redundant parent edges   | Skill                               | Missing | P4       |
| `edit`             | Enter a revision to amend it    | `jj_edit` tool                      | Missing | P1       |
| `split`            | Split by path/hunk              | `jj_commit({mode:"split"})`         | Partial | P1       |
| `absorb`           | Distribute edits into ancestors | `jj_repair`                         | Missing | P0       |
| `converge`         | Collapse divergent changes      | `jj_repair({action:"converge"})`    | Missing | P0       |

### 1.4 Conflicts

| jj feature             | Agent use                           | Delivery                                                            | Status  | Priority |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------- | ------- | -------- |
| `status` conflict flag | Is `@` conflicted?                  | `jj_status({conflict})`                                             | Exists  | P0       |
| `resolve --list`       | Which paths conflict?               | **`jj_status({conflicts:[...]})`**                                  | Missing | P1       |
| `resolve <path>`       | Resolve with an external merge tool | Skill only — interactive; the agent edits conflict markers directly | —       | —        |
| `diff` on a conflict   | Show markers and sides              | `jj_diff` tool                                                      | Exists  | —        |

### 1.5 Verification

| jj feature                       | Agent use                                                        | Delivery                                                 | Status  | Priority |
| -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- | ------- | -------- |
| `run --ignore-changes`           | Run a command across a revision stack in isolated working copies | `jj_test({mode:"run"})` or skill                         | Missing | P3       |
| `bisect run`                     | Find the first bad revision automatically                        | **`jj_test({mode:"bisect"})`** in an ephemeral workspace | Missing | P3       |
| `fix`                            | Apply configured formatters to revisions                         | **`jj_fix` tool**, conditional on `fix.tools` config     | Missing | P3       |
| `run` without `--ignore-changes` | Run and amend each revision                                      | Skill — dangerous, rewrites history                      | —       | —        |

### 1.6 Workspaces

| jj feature               | Agent use                                             | Delivery                                | Status  | Priority |
| ------------------------ | ----------------------------------------------------- | --------------------------------------- | ------- | -------- |
| `workspace add`          | One workspace per agent                               | `jj_workspace({action:"add"})`          | Missing | P0       |
| `workspace list`         | Who is where                                          | `jj_workspace({action:"list"})`         | Missing | P0       |
| `workspace remove`       | Remove a worker's workspace **and snapshot its work** | `jj_workspace({action:"remove"})`       | Missing | P0       |
| `workspace forget`       | Stop tracking, leave files (discard)                  | `jj_workspace({action:"forget"})`       | Missing | P0       |
| `workspace update-stale` | Heal a stale workspace                                | `jj_workspace({action:"update-stale"})` | Missing | P0       |
| `workspace root`         | Confirm the current root                              | `jj_workspace({action:"root"})`         | Missing | P0       |
| `workspace rename`       | Rename a workspace                                    | Skill                                   | Missing | P4       |

### 1.7 Recovery and the operation log

| jj feature      | Agent use                                         | Delivery                             | Status                    | Priority |
| --------------- | ------------------------------------------------- | ------------------------------------ | ------------------------- | -------- |
| `op log`        | List operations                                   | `jj_op({action:"log"})`              | Exists as `jj_op_log`     | P0       |
| `op show`       | What an operation changed                         | `jj_op({action:"show"})`             | Missing                   | P2       |
| `op diff`       | Diff between two operations                       | `jj_op({action:"diff"})`             | Missing                   | P2       |
| `op restore`    | Restore to a checkpoint                           | `jj_op({action:"restore"})`          | Exists as `jj_op_restore` | P0       |
| `op revert`     | Revert one operation without restoring everything | `jj_op({action:"revert"})`           | Missing                   | P2       |
| `op abandon`    | Prune old operation history                       | `jj_op({action:"abandon"})` or skill | Missing                   | P2       |
| `op integrate`  | Integrate a `--no-integrate-operation` result     | `jj_op({action:"integrate"})`        | Missing                   | P2       |
| `undo` / `redo` | Undo the last workspace-local operation           | `jj_repair({action:"undo"            | "redo"})`                 | Missing  | P0  |
| `util snapshot` | Explicit checkpoint                               | `jj_status({snapshot:true})`         | Missing                   | P0       |
| `util gc`       | Garbage-collect old operations/objects            | Skill only — admin                   | —                         | —        |

### 1.8 Publishing

| jj feature                                                         | Agent use                        | Delivery                                        | Status                 | Priority |
| ------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------- | ---------------------- | -------- |
| `bookmark list/create/set/move/delete/forget/rename/track/untrack` | Name revisions, publish boundary | `jj_bookmark` tool                              | Exists                 | —        |
| `tag list/set/delete/track/untrack`                                | Release tags                     | `jj_publish({action:"tag-*"})` or skill         | Missing                | P3       |
| `git push`                                                         | Publish a bookmark/tag/change    | **`jj_publish({action:"push"})` with approval** | Missing (deliberately) | P3       |
| `git fetch`                                                        | Fetch remote changes             | `jj_publish({action:"fetch"})` or skill         | Missing                | P3       |
| `git clone` / `git init`                                           | Create/import a repo             | Adoption flow (`src/adopt.ts`)                  | Exists                 | —        |
| `git remote`                                                       | Inspect remotes                  | Skill                                           | Missing                | P3       |
| `git export` / `git import`                                        | Colocated Git sync               | Skill — colocated repos do this automatically   | —                      | —        |

### 1.9 Repo hygiene and configuration

| jj feature                             | Agent use                                                     | Delivery                                        | Status  | Priority |
| -------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- | ------- | -------- |
| `config get/list/set`                  | Set `snapshot.auto-update-stale`, `fix.tools`, `git.colocate` | `jj_doctor` read-only report + skill for writes | Missing | P3       |
| `sparse list/set/reset`                | Monorepo partial checkout                                     | **`jj_sparse` tool**, conditional on sparse use | Missing | P4       |
| `sign` / `unsign`                      | Signed commits                                                | `jj_sign` conditional tool or skill             | Missing | P4       |
| `gerrit`                               | Gerrit review                                                 | Out of scope unless the user uses Gerrit        | —       | —        |
| `util gc`                              | Maintenance                                                   | Skill only — admin                              | —       | —        |
| `debug`, `completion`, `markdown-help` | Not agent-facing                                              | Not exposed                                     | —       | —        |

### 1.10 The map in one sentence

**Tools cover the verbs an agent repeats every turn** (status, log, diff, show,
file, evolog, new, commit, describe, edit, squash, split, rebase, history,
workspace, test, repair, op, bookmark, publish, hunk). **Skills cover the verbs
that are interactive, rare, or user-configured** (next/prev, parallelize,
simplify-parents, resolve tool, fix, bisect, tag, fetch, remote, sparse, sign,
gc). **The guard covers Git.** Nothing is exposed just because `jj` has it.

### 1.11 Five workflows the surface must support

If a workflow cannot be expressed with the map above, the map is incomplete.

| Workflow              | Chain                                                                                                               | What it proves                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Feature loop**      | `jj_status` → `jj_edit`/`jj_commit` → `jj_diff` → `jj_test` → `jj_bookmark`                                         | The daily authoring path works without a shell   |
| **Stack maintenance** | `jj_log` → `jj_history({action:"rebase"})` → `jj_test({mode:"run"})` → `jj_diff({mode:"interdiff"})` → `jj_publish` | A stack can be kept current and reviewed         |
| **Parallel agents**   | `jj_workspace({action:"add"})` → `subagent({cwd})` → `jj_test` → `jj_workspace({action:"remove"})`                  | Isolation without path rewriting                 |
| **Recovery**          | `jj_status.opId` → `jj_op({action:"show"})` → `jj_op({action:"restore"})` / `jj_repair({action:"undo"})`            | A bad turn is reversible                         |
| **Review**            | `jj_show` → `jj_file` → `jj_evolog` → `jj_diff({mode:"interdiff"})`                                                 | An agent can explain a change, not just make one |

---

## 2. Tool surface architecture

### 2.1 Three tiers, selected by config

The plugin already pays roughly 1,000–1,500 tokens for 11 tools
([docs/18](18-tool-surface.md)). The full map above would cost 2,500–3,500 if
every verb became a tool. That is too much for a default. Add a `toolset`
setting:

| Tier             | Tools                                                                                                     | Estimated schema cost | Who it is for                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------ |
| `minimal`        | 5: `jj_status`, `jj_log`, `jj_diff`, `jj_new`, `jj_hunk_apply`                                            | ~500–700              | Guard-first users, tiny models                         |
| `core` (default) | 14: the current 11 + `jj_workspace`, `jj_test`, `jj_repair` (plus the `jj_status` changes)                | ~1,450–2,100          | Normal single-agent and small multi-agent work         |
| `full`           | 20: core + `jj_show`, `jj_file`, `jj_evolog`, `jj_commit`, `jj_edit`, `jj_history`, `jj_op`, `jj_publish` | ~2,100–2,800          | Power users, long-running agents, stacked-PR workflows |

`full` replaces `jj_op_log` and `jj_op_restore` with the single `jj_op` family;
`core` keeps the two existing tools for compatibility. The exact tier is a
setting, so a user who wants “all the features” pays for them and a user who
wants a small prompt does not.

### 2.2 Conditional tools

Three tools should be registered **only when the repo is configured for them**,
so the schema is not spent on a capability that cannot run:

| Tool        | Condition                               | Why                                                                  |
| ----------- | --------------------------------------- | -------------------------------------------------------------------- |
| `jj_fix`    | `jj config list fix.tools` is non-empty | Without formatter config, `jj fix` is a no-op with a confusing error |
| `jj_sparse` | `jj sparse list` is not the default `.` | Sparse is a monorepo tool, not a default                             |
| `jj_sign`   | `signing.backend` is configured         | Signing is compliance-specific                                       |

The condition is evaluated at mount (the config is already read by
`resolveSettings`). A config change requires a remount; that is acceptable for
these three.

### 2.3 Family tools, not one tool per command

Continue the `jj_bookmark` pattern: one tool per **family**, with an `action`
enum and per-action args.

| Family         | Actions                                                            | Why one tool                                                    |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `jj_file`      | `list`, `show`, `search`, `annotate`                               | All read the tree at a revision; one schema, one output shape   |
| `jj_history`   | `rebase`, `duplicate`, `revert`, `abandon`, `restore`, `metaedit`  | All rewrite or move history; one “surgery” family               |
| `jj_op`        | `log`, `show`, `diff`, `restore`, `revert`, `abandon`, `integrate` | The operation log is one concept; `log`/`restore` already exist |
| `jj_repair`    | `undo`, `redo`, `absorb`, `converge`                               | “Fix a broken multi-agent state” is one story                   |
| `jj_workspace` | `list`, `add`, `remove`, `forget`, `update-stale`, `root`          | Workspaces are one concept                                      |
| `jj_publish`   | `push`, `fetch`, `tag-list`, `tag-set`, `tag-delete`               | Publishing leaves the machine; one approval boundary            |
| `jj_test`      | `run`, `bisect` (and the default ephemeral test)                   | Verification is one workflow                                    |

`jj_commit` has two modes (`commit`, `split`) but stays one tool: both are
“describe and divide the working copy”. `jj_rebase` is an action of
`jj_history`, not a separate tool, because it shares the “move revisions”
concept and the same safety checks.

### 2.4 What stays a skill

The skill family, not the tool schema, carries the long tail:

| Skill                | Contents                                                                                                                      | Why not a tool                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `jujutsu` (existing) | Model, change vs commit ids, the tool list, hunk queries, Git→jj map                                                          | The rule must be in the prompt; the body is on demand             |
| `jujutsu-history`    | `rebase` flags, `split`, `absorb`, `duplicate`, `revert`, `abandon`, `restore`, `metaedit`, `parallelize`, `simplify-parents` | Depth without schema cost; the tool covers the common path        |
| `jujutsu-verify`     | `run`, `fix`, `bisect`, test isolation, CoW workspaces                                                                        | Config-dependent; commands are long                               |
| `jujutsu-recovery`   | `op log/show/diff/restore/revert/undo/redo`, `util snapshot`, `op abandon`, `util gc`                                         | Rare but critical; the model can read it when needed              |
| `jujutsu-publish`    | Bookmarks, tags, `git push`/`fetch`/`remote`, `--change`, safety checks                                                       | Publishing is an approval boundary; the skill explains the policy |

Five skills cost roughly 150–300 tokens of catalog lines and keep the detailed
flags out of the system prompt. The existing `jujutsu` description is 206
characters; each new description should stay under the same 214-character
break-even ([docs/32](32-probe-results-teaching.md) §Q3).

### 2.5 MCP is a distribution adapter, not a feature

An MCP server for `jj` would not add a capability: the CLI already exposes the
commands, and `-T 'json(self)'` already returns structured data for `log`,
`show`, `evolog`, `op`, `bookmark`, `workspace`, and `tag`. The native tools are
the DSH adapter; an MCP server would be a **second adapter** with its own
schemas, process, lifecycle, and version probe — and no way to enforce the
`tools/pre-execute` Git guard on the client's other tools.

Build one only if a **concrete non-DSH client** needs the same surface
(Claude Code, Cursor, CI). If that happens, extract a client-agnostic core and
generate both adapters from it; do not hand-write a second surface. The full
argument is [docs/36](36-ai-and-jujutsu.md).

---

## 3. Detailed specs for the new capabilities

### 3.1 `jj_show`

```
jj_show({ revset?: string, patch?: boolean })
```

- Default `revset` is `@`.
- Backing: `jj log --no-graph -T 'json(self) ++ "\n"' -r <revset>` for metadata,
  plus `jj show --summary -r <revset>` for the file list.
- `patch:true` adds `jj diff --git -r <revset>` (bounded; truncate with a clear
  marker rather than silently dropping the tail).
- Returns `{commit, files, patch?}`.
- Read-only: `--ignore-working-copy` on both calls.

Why a tool: the model otherwise makes two calls (`jj_log` + `jj_diff`) and
reconstructs the relationship; `jj show` is the one-revision view.

### 3.2 `jj_file`

```
jj_file({
  action: "list" | "show" | "search" | "annotate",
  revision?: string,
  paths?: string[],
  pattern?: string,
  lineNumbers?: boolean,
  maxBytes?: number
})
```

- `list`: `jj file list -r <rev> -T 'path ++ "\n"' [paths...]`.
- `show`: `jj file show -r <rev> <paths...>`; cap at `maxBytes` (default 64 KiB
  per file) and mark truncation.
- `search`: `jj file search -r <rev> --pattern <pattern> [--name-only]
  [--line-number] [paths...]`; parse `<path>:<line>` into structured rows.
- `annotate`: `jj file annotate -r <rev> <path>`; return raw lines plus a
  parsed `{changeId, author, line, text}` where the format allows it.
- Read-only: `--ignore-working-copy`.

Why a tool: reading a file at a historical revision is not possible with the
harness `read` tool, and `jj file search` is the only way to search a revision
without checking it out.

### 3.3 `jj_evolog`

```
jj_evolog({ revset?: string, limit?: number, patch?: boolean })
```

- Backing: `jj evolog --no-graph -T 'json(self) ++ "\n"' -r <revset> [--limit n]`.
- `patch:true` adds `-p --summary` or a bounded diff.
- Returns `[{commit, operation}]`.
- Read-only: `--ignore-working-copy`.

Why a tool: `evolog` is the answer to “what did this change look like before the
rebase?”, which is exactly the question an agent asks after a failed rewrite.
The JSON template exists and is stable in 0.46.

### 3.4 `jj_commit`

```
jj_commit({
  mode?: "commit" | "split",   // default "commit"
  message: string,
  paths?: string[],
  revision?: string,           // split only; default @
  parallel?: boolean,          // split only
  onto?: string,               // split only
  insertAfter?: string,
  insertBefore?: string
})
```

- `commit`: `jj commit -m <message> [paths...]`. Selected paths stay in the
  current commit; the rest move to a new working-copy commit. This is the
  one-call version of `jj_describe` + `jj_new`.
- `split`: `jj split -r <rev> -m <message> [paths...] [--parallel] [-o ...]`.
  The selected changes become the first commit; the remainder keeps the
  original description. Measured: `-m` is non-interactive; the remaining
  commit does not prompt.
- Identity check before either mode (both mint commits).
- Returns `{committed: changeId, workingCopy: changeId, opId}`.

Why a tool: `commit` is the most common authoring gesture, and `split` by path
is the non-interactive complement to `jj-hunk`’s hunk split.

### 3.5 `jj_edit`

```
jj_edit({ revset: string })
```

- Backing: `jj edit <revset>`.
- Returns `{workingCopy: {changeId, commitId}, parent: ...}`.
- Refuses if `@` is conflicted? `jj edit` can enter a conflicted commit; the
  existing `conflictRefusal` is for tools that rewrite `@`. `jj_edit` changes
  which commit `@` is; it does not rewrite the tree. Allow it, but return the
  conflict flag so the model knows.
- Note in the description: jj recommends `jj new` + `jj squash` for most
  work; `jj_edit` is for resuming an existing change, and the agent must own
  that change (one writer per change).

Why a tool: without it, an agent cannot amend an existing change; `jj_new`
only creates a child.

### 3.6 `jj_history`

```
jj_history({
  action: "rebase" | "duplicate" | "revert" | "abandon" | "restore" | "metaedit",
  ...
})
```

Per action:

| Action      | Args                                                                                         | Backing        |
| ----------- | -------------------------------------------------------------------------------------------- | -------------- |
| `rebase`    | `source?`, `branch?`, `revisions?`, `onto?`, `insertAfter?`, `insertBefore?`, `skipEmptied?` | `jj rebase`    |
| `duplicate` | `revsets`, `onto?`, `insertAfter?`, `insertBefore?`                                          | `jj duplicate` |
| `revert`    | `revision`, `onto?`, `insertAfter?`, `insertBefore?`                                         | `jj revert`    |
| `abandon`   | `revsets`, `retainBookmarks?`, `restoreDescendants?`                                         | `jj abandon`   |
| `restore`   | `paths?`, `from?`, `into?`, `changesIn?`                                                     | `jj restore`   |
| `metaedit`  | `revsets`, `author?`, `message?`                                                             | `jj metaedit`  |

Rules:

- `rebase` validates exactly one of `source`/`branch`/`revisions` and exactly
  one of `onto`/`insertAfter`/`insertBefore`. Passing none uses jj’s default
  (`-b @`), which is rarely what an agent means; require an explicit choice.
- Every action captures `beforeOpId` and returns `afterOpId`, so a bad rebase
  can be undone with `jj_op({action:"restore", opId: beforeOpId})`.
- `abandon` and `restore` are destructive; the tool description says so and
  returns the affected change ids.
- Do not pass `--ignore-immutable` unless the caller sets `allowImmutable:true`;
  that flag is a separate, explicit escape hatch.

Why a tool family: these are the verbs that maintain a stack. Without them, an
agent can create changes but cannot keep them rebased, reordered, or clean.

### 3.7 `jj_op`

```
jj_op({
  action: "log" | "show" | "diff" | "restore" | "revert" | "abandon" | "integrate",
  ...
})
```

| Action      | Args                                      | Backing           | Returns                           |
| ----------- | ----------------------------------------- | ----------------- | --------------------------------- |
| `log`       | `limit?`, `atOp?`                         | `jj op log`       | JSON entries                      |
| `show`      | `opId`, `patch?`                          | `jj op show`      | raw text + parsed changed commits |
| `diff`      | `from`, `to`, `summary?`                  | `jj op diff`      | raw text + parsed summary         |
| `restore`   | `opId`                                    | `jj op restore`   | `{restored: true, opId}`          |
| `revert`    | `opId`                                    | `jj op revert`    | `{reverted: true, opId}`          |
| `abandon`   | `operation` (a range such as `..<op-id>`) | `jj op abandon`   | `{abandoned: true}`               |
| `integrate` | `opId`                                    | `jj op integrate` | `{integrated: true}`              |

Rules:

- `log`/`show`/`diff` use `--ignore-working-copy`.
- `restore`/`revert`/`abandon`/`integrate` are mutations; they return the new
  op id.
- `restore` is the checkpoint restore; `revert` is the surgical undo of one
  operation. The description must distinguish them, because “restore” sounds
  safer than it is.
- `jj_op` replaces `jj_op_log` + `jj_op_restore` in the `full` tier; `core`
  keeps the old two names as aliases for one release.

Why a tool family: the op log is the recovery engine; the model should not
have to parse `jj op show` prose to find the operation that broke a rebase.

### 3.8 `jj_repair`

```
jj_repair({
  action: "undo" | "redo" | "absorb" | "converge",
  ...
})
```

| Action     | Args                                   | Backing                        |
| ---------- | -------------------------------------- | ------------------------------ |
| `undo`     | `allowCrossWorkspace?` (default false) | `jj undo`                      |
| `redo`     | —                                      | `jj redo`                      |
| `absorb`   | `from?`, `into?`, `paths?`             | `jj absorb`                    |
| `converge` | `revset?` (default `divergent()`)      | `jj converge --no-interactive` |

Rules:

- `undo`/`redo` are workspace-local by default; `allowCrossWorkspace:true` is
  the explicit opt-in and the description warns that it can undo another
  agent’s work.
- `absorb` snapshots `@` first (it is a mutation); it leaves new files and
  ambiguous hunks in `@` — the tool returns `remaining` paths.
- `converge` reports `before`/`after` divergent change ids and `resolved`.

### 3.9 `jj_workspace`

```
jj_workspace({
  action: "list" | "add" | "remove" | "forget" | "update-stale" | "root",
  name?: string,
  path?: string,
  revset?: string,
  colocate?: boolean
})
```

- `add` creates a colocated workspace (`--colocate`) and returns the absolute
  path, change id, and commit id. The Lead passes that path to
  `subagent({cwd})`.
- `remove` calls `jj workspace remove`, which snapshots the workspace’s
  working-copy state into a commit **before** deleting the directory. Use it
  for a worker whose work should survive. The main workspace cannot be
  removed.
- `forget` stops tracking but leaves the directory; use it with `rm -rf` for
  an ephemeral test workspace whose artifacts should be discarded.
- `update-stale` is the manual escape hatch when
  `snapshot.auto-update-stale` is false.
- `root` returns the current workspace root.

### 3.10 `jj_test`

```
jj_test({
  mode?: "test" | "run" | "bisect",   // default "test"
  revision?: string,                  // test/run
  range?: string,                     // bisect
  command: string,
  deps?: "clone" | "install" | "none",
  timeoutMs?: number,
  keep?: boolean
})
```

- `test`: ephemeral workspace at `revision`, CoW-cloned `node_modules`, run
  the command, clean up. (Detailed in [docs/38](38-multi-agent-and-plugin-capacity.md) §5.2.)
- `run`: `jj run --ignore-working-copy --ignore-changes -r <revision> -- <cmd>`.
  For dependency-free checks across a stack; no `node_modules`, persistent
  `.jj/run` working copies.
- `bisect`: `jj bisect run --range <range> -- <cmd>` in an ephemeral
  workspace. Bisect edits each revision as the working copy; never run it in
  the caller’s `@`.
- `fix` is **not** a mode here; it is the conditional `jj_fix` tool.

### 3.11 `jj_publish`

```
jj_publish({
  action: "push" | "fetch" | "tag-list" | "tag-set" | "tag-delete",
  remote?: string,
  bookmark?: string,
  tag?: string,
  revision?: string,
  change?: string,
  all?: boolean,
  allowMove?: boolean,
  dryRun?: boolean
})
```

- `push` requires the same approval path as the Git bypass
  ([docs/17](17-bypass-and-approval.md)): it leaves the machine and cannot be
  quietly undone. `dryRun:true` maps to `jj git push --dry-run`.
- `fetch` is read-only in the local sense but mutates remote-tracking
  bookmarks; it is allowed without approval.
- `tag-list` maps to `jj tag list`; `tag-set` maps to `jj tag set <tag> -r
  <revision> [--allow-move]`; `tag-delete` maps to `jj tag delete <tag>`.
  Tags are local until pushed.
- `--change` maps to `jj git push -c <revset>`, which creates a bookmark for
  the change and pushes it.
- Never push automatically after a commit. The model asks.

### 3.12 `jj_fix` (conditional)

```
jj_fix({ revsets?: string, paths?: string[] })
```

- Backing: `jj fix -s <revsets> [paths...]`.
- Registered only when `fix.tools` is non-empty.
- Returns `{fixed: [changeId], opId}`.
- `jj fix` rewrites the reachable mutable stack; the tool captures
  `beforeOpId` and says so.

### 3.13 `jj_sparse` (conditional)

```
jj_sparse({ action: "list" | "set" | "reset", add?: string[], remove?: string[], clear?: boolean })
```

- `list`: `jj sparse list`.
- `set`: `jj sparse set --add ... --remove ... --clear`.
- `reset`: `jj sparse reset`.
- Registered only when sparse patterns exist.
- Returns the new pattern list; `set`/`reset` return `opId`.

### 3.14 `jj_status` additions

| Field                | Source                    | Why                             |
| -------------------- | ------------------------- | ------------------------------- |
| `snapshot?: boolean` | `jj util snapshot` first  | Explicit checkpoint             |
| `opId`               | `jj op log --limit 1`     | Restore point                   |
| `divergent`          | `jj log -r 'divergent()'` | Detect concurrent-edit damage   |
| `conflicts`          | `jj resolve --list`       | Paths the agent must edit       |
| `workspace`          | `jj workspace root`       | Confirm the session’s workspace |

All read queries use `--ignore-working-copy`; only `snapshot:true` writes.

---

## 4. Cross-cutting conventions

### 4.1 Read purity

Every read path goes through one helper:

```ts
export function readOnly(args: readonly string[]): string[] {
  return [...args, "--ignore-working-copy"];
}
```

This includes `jj_status`, `jj_log`, `jj_diff`, `jj_show`, `jj_file`,
`jj_evolog`, `jj_op log/show/diff`, `jj_workspace list/root`, and the
`conflictOf` / `identityConfigured` pre-checks. `jj-hunk` has no flag (M7 in
docs/38), so `jj_hunk_list` remains the documented exception; run it in the
agent’s own workspace.

### 4.2 Every mutation returns an operation id

Add `opId` to every mutating result, and `beforeOpId` to destructive ones
(`rebase`, `abandon`, `restore`, `absorb`, `fix`, `op restore/revert`). The
model can then call `jj_op({action:"restore", opId: beforeOpId})` without a
separate `jj_op_log` round trip. This is the single highest-value safety
convention in the whole surface.

### 4.3 Pre-flight checks

| Check               | When                                                                         | Behavior                                                               |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Identity configured | Any tool that mints a commit (`new`, `commit`, `split`, `hunk split/commit`) | Refuse with `JJ_IDENTITY_UNCONFIGURED`                                 |
| Conflicted `@`      | Tools that rewrite `@` (`new`, `squash`, `hunk apply`, `split`)              | Refuse with `JJ_CONFLICTS_PRESENT`                                     |
| Immutable commits   | `rebase`, `abandon`, `restore`, `metaedit`, `fix`                            | Let jj refuse; offer `allowImmutable:true` as an explicit escape hatch |
| Stale workspace     | Any tool after `jj workspace list` reports stale                             | Return `JJ_WORKSPACE_STALE` with `jj workspace update-stale`           |
| Divergence          | `jj_status`                                                                  | Report `divergent`; `jj_repair converge` is the fix                    |
| `jj` version        | Tool registration                                                            | Existing `MINIMUM_JJ` probe                                            |

### 4.4 Output shape

Keep the existing convention: a tool returns a bare JSON value, or
`{error:{code,message,hint?}}`. Do not introduce a new envelope in this
release; it would break every existing tool. New tools add `opId` fields to
their success values.

### 4.5 Error codes

New codes, one per family, not one per command:

```
JJ_WORKSPACE_DESTINATION_NOT_EMPTY
JJ_WORKSPACE_STALE
JJ_WORKSPACE_NOT_FOUND
JJ_TEST_DEPS_STALE
JJ_TEST_WORKSPACE_FAILED
JJ_REBASE_SOURCE_AMBIGUOUS
JJ_REBASE_DESTINATION_AMBIGUOUS
JJ_HISTORY_IMMUTABLE
JJ_OP_NOT_FOUND
JJ_PUBLISH_APPROVAL_REQUIRED
JJ_FIX_NOT_CONFIGURED
JJ_SPARSE_NOT_CONFIGURED
```

### 4.6 Testing

| Layer       | What it proves                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Argv builders, validation, error mapping; no shell                                                                                            |
| Integration | Each tool against a throwaway `jj` repo with a known fixture                                                                                  |
| E2E         | A full agent loop: workspace → edit → commit → split → rebase → test → bookmark → push to a local bare remote → op restore → workspace remove |
| Regression  | Every existing tool’s output unchanged except documented additions                                                                            |
| Hermetic    | No network; `jj` and `jj-hunk` pinned; no absolute paths in fixtures                                                                          |

---

## 5. Phases

### P0 — Safety and core (the docs/38 program)

This is not one sprint; it is the four phases of
[docs/38](38-multi-agent-and-plugin-capacity.md) taken together. The outcome
is the `core` tier of 14 tools.

Deliverables:

1. docs/38 P0: `readOnly()` + `--ignore-working-copy` on every read;
   `jj_status({snapshot:true})`, `opId`, `divergent`, `conflicts`; `startOp` in
   the prompt; guard `git worktree` mappings; two-workspace read-purity test.
2. docs/38 P1: `jj_workspace` (list/add/remove/forget/update-stale/root).
3. docs/38 P2: `jj_test` (ephemeral workspace, CoW deps, cleanup).
4. docs/38 P3: `jj_repair` (undo/redo/absorb/converge).
5. Skill card updates for the new core tools.

Acceptance: the docs/38 acceptance criteria; `core` registers 14 tools;
`jj_log` in a dirty workspace creates zero operations; a `jj_test` run leaves
no workspace and no `@` change.

### P1 — Daily authoring and inspection

Deliverables:

1. `jj_show`, `jj_file`, `jj_evolog`.
2. `jj_commit` (`commit` + `split`), `jj_edit`.
3. `jj_status.conflicts` from `jj resolve --list`.
4. Full-tier registration (`toolset:"full"`), with `core` unchanged.
5. Skill: `jujutsu-history` (first half: commit/split/edit).

Acceptance: an agent can read a revision’s metadata, files, and evolution;
commit or split its work; resume an existing change; and see conflicts —
without shelling out.

### P2 — Stack surgery and recovery

Deliverables:

1. `jj_history` (`rebase`, `duplicate`, `revert`, `abandon`, `restore`,
   `metaedit`).
2. `jj_op` (`log`, `show`, `diff`, `restore`, `revert`, `abandon`,
   `integrate`); deprecate `jj_op_log`/`jj_op_restore` in `full`.
3. `jj_diff({mode:"interdiff"})` or a separate `jj_interdiff` read.
4. `beforeOpId`/`opId` on every destructive tool.
5. Skill: `jujutsu-recovery` and the second half of `jujutsu-history`.

Acceptance: an agent can rebase a stack onto a new parent, undo a bad rebase
with one `jj_op restore`, and explain what an operation changed.

### P3 — Verification and publishing

Deliverables:

1. `jj_test({mode:"run"})` for dependency-free stack checks.
2. `jj_test({mode:"bisect"})` in an ephemeral workspace.
3. `jj_fix` (conditional on `fix.tools`).
4. `jj_publish` (`push`/`fetch`/tags) with the approval gate.
5. Preflight `jj_doctor` report (not a tool): jj version, repo kind, workspace
   count, `snapshot.auto-update-stale`, `max-new-file-size`, `git.colocate`,
   op-log head, `jj-hunk` version, divergence, sparse patterns.
6. Skill: `jujutsu-verify` and `jujutsu-publish`.

Acceptance: an agent can bisect a regression, format a stack, and publish a
bookmark to a local bare remote only after approval.

### P4 — Scale and niche

Deliverables:

1. `jj_sparse` (conditional), `jj_sign`/`jj_unsign` (conditional).
2. `jj_workspace rename`, `jj next/prev` skill recipes.
3. `jj parallelize` / `simplify-parents` skill recipes.
4. Docs: a “day in the life” walkthrough and a capability matrix update.

Acceptance: a monorepo agent can work in a sparse workspace; a signing-
configured repo can sign commits; the full tier (without conditionals) stays
under ~2,800 tokens.

**Effort:** P0 is the docs/38 program (~2 weeks); P1 1 week; P2 1 week;
P3 1 week; P4 3–5 days. The full surface is roughly a month of focused work,
but each phase ships independently.

---

## 6. Capacity model

### 6.1 Tool surface

| Tier                  | Tools | Schema cost  | Best for                       |
| --------------------- | ----- | ------------ | ------------------------------ |
| `minimal`             | 5     | ~500–700     | Guard-first, tiny models       |
| `core`                | 14    | ~1,450–2,100 | Default                        |
| `full`                | 20    | ~2,100–2,800 | Power users                    |
| `full` + conditionals | 23    | ~2,300–3,000 | Monorepos, signing, formatters |

The skill family adds ~150–300 tokens of catalog lines, not full bodies.

### 6.2 Agent concurrency

| Workload                               | Ceiling             | Why                                            |
| -------------------------------------- | ------------------- | ---------------------------------------------- |
| Scoped tests in per-agent workspaces   | 8+ agents           | CPU-bound; no shared `@`                       |
| Full-suite `jj_test`                   | 2–4 concurrent      | Full checkout + test process                   |
| `jj_test({mode:"run"})` across a stack | 1–2                 | One working copy per revision; `-j` multiplies |
| `jj_test({mode:"bisect"})`             | 1                   | It edits each revision; isolate it             |
| Workspace add/remove                   | Serialized per repo | Git worktree creation is the slow part         |

### 6.3 Disk and op log

- A workspace checkout duplicates tracked files; `node_modules` is CoW-cloned
  and costs ~0 extra bytes on APFS.
- `jj run`/`bisect` working copies live under `.jj/run/...`; prune them.
- Every mutation returns an op id; `jj op abandon` + `jj util gc` is the
  retention path. The plugin does not need a background janitor.

---

## 7. What not to build

| Proposal                                                                    | Verdict               | Reason                                                                                                                |
| --------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| One tool per `jj` subcommand                                                | **Reject**            | 40+ tools would cost 4,000+ schema tokens and most would never be called                                              |
| One generic `jj` tool with a free-form args bag                             | **Reject as default** | No validation, no structure, worst discoverability; `bash jj` already exists                                          |
| MCP server instead of native tools                                          | **Reject**            | The repo’s existing argument ([docs/36](36-ai-and-jujutsu.md)) still holds: native tools + guard is cheaper and safer |
| Path-rewriting / virtual filesystem                                         | **Reject**            | DSH pre-execute cannot mutate arguments; use `subagent({cwd})`                                                        |
| Interactive commands (`arrange`, `diffedit`, `sparse edit`, `resolve` tool) | **Skill only**        | A TUI in an agent loop hangs rather than fails                                                                        |
| Auto-push after commit                                                      | **Reject**            | Publishing leaves the machine; approval must be explicit                                                              |
| Auto-restore after a failed turn                                            | **Reject**            | Destructive and judgement-heavy; expose the checkpoint                                                                |
| Auto-absorb after every turn                                                | **Reject**            | Rewrites parent commits; leaves new files/ambiguous hunks; races other agents                                         |
| `--ignore-immutable` by default                                             | **Reject**            | Immutability is a safety property; make it an explicit `allowImmutable`                                               |
| `jj util gc` as a tool                                                      | **Reject**            | Admin operation; a skill recipe is enough                                                                             |
| Gerrit support                                                              | **Defer**             | Niche; only if a user asks                                                                                            |
| `debug`/`completion`/`markdown-help`                                        | **Not exposed**       | Not agent-facing                                                                                                      |

---

## 8. Open questions

1. **Default `toolset`.** `core` is the safe default; `full` is the “all
   features” answer. Should `full` be the default for users who install the
   plugin explicitly, and `core` for bundle users? Recommendation: `core`
   default, `full` documented as one setting away.
2. **`jj_op` vs `jj_op_log`/`jj_op_restore`.** Replacing them in `full` is a
   breaking change for anyone who scripts the old names. Keep aliases for one
   minor release, then remove.
3. **`jj_publish` approval.** Reuse the existing `bypass` setting, or add a
   separate `publish: "ask" | "deny" | "allow"`? Publishing is a different
   risk from a Git write; a separate setting is clearer.
4. **`jj_split` interactivity.** `-m` is non-interactive in the measured case,
   but `jj split` may still prompt when the remaining commit needs a
   description or when `--parallel` is used. Test the full matrix before
   shipping; fall back to `jj-hunk` for hunk selection.
5. **`jj_bisect` isolation.** It edits each revision as the working copy.
   Running it in an ephemeral workspace is safe but slower; running it in the
   caller’s workspace is faster but disrupts the agent. Recommendation:
   ephemeral, and `keep:true` for debugging.
6. **`jj_fix` config.** `fix.tools` is user config; the tool must not invent
   formatters. Conditional registration is the plan, but a config change
   mid-session requires a remount.
7. **`jj_file show` size.** A 10 MB generated file would blow the tool output.
   Cap at 64 KiB per file by default and return a `truncated` marker with a
   `jj_file({action:"show", maxBytes:...})` escape hatch.
8. **`jj_workspace remove` vs `forget`.** `remove` snapshots the workspace’s
   working-copy state into a commit; `forget` discards. The tool descriptions
   must make the difference impossible to miss. `jj_test` uses `forget` +
   `rm -rf`.
9. **`jj_sign` conditional tool.** Signing is config-dependent and rare; a
   skill recipe may be enough. Decide after a user asks.
10. **Gerrit.** Out of scope until a user needs it; `jj gerrit` is a separate
    workflow with its own review model.

---

## 9. Acceptance criteria

The full surface is done when:

1. **Read purity.** Every read tool uses `--ignore-working-copy`; a read in a
   dirty workspace creates zero operations.
2. **Checkpoint.** Every mutating tool returns `opId`; every destructive tool
   returns `beforeOpId`; `jj_op restore` to `beforeOpId` restores the state.
3. **Orientation.** `jj_show`, `jj_file` (list/show/search/annotate), and
   `jj_evolog` return structured JSON on a real repo.
4. **Authoring.** `jj_commit` (commit/split) and `jj_edit` work without an
   editor; identity/conflict checks fire.
5. **Surgery.** `jj_history` rebase/duplicate/revert/abandon/restore/metaedit
   work on a stacked fixture; a bad rebase is recoverable with `jj_op restore`.
6. **Recovery.** `jj_op` log/show/diff/restore/revert/abandon/integrate and
   `jj_repair` undo/redo/absorb/converge pass their fixtures.
7. **Workspaces.** `jj_workspace` add/list/remove/forget/update-stale/root
   work; `subagent({cwd})` operates in the new workspace; `remove` preserves
   work, `forget` discards.
8. **Verification.** `jj_test` test/run/bisect work; `jj_fix` is registered
   only when configured.
9. **Publishing.** `jj_publish` push requires approval; `dryRun` works; tag
   list/set/delete work.
10. **Budget.** `minimal`/`core`/`full` register the documented tools; the
    full tier stays under ~2,800 tokens.
11. **Regression.** `pnpm ci` green; the existing 11 tools keep their
    behaviour except the documented `jj_status` additions.

---

## 10. References

- [11 — verified DSH API contract](11-verified-dsh-api-contract.md):
  `PreToolDecision`, `tools/execute`, and why argument rewriting is not a hook.
- [17 — bypass and approval](17-bypass-and-approval.md): the approval path for
  `jj_publish`.
- [18 — tool surface](18-tool-surface.md): the schema budget and the
  one-tool-per-family rule.
- [27 — integration surfaces](27-integration-surfaces.md): the lifecycle hooks.
- [30 — lifecycle](30-lifecycle-and-observability-surfaces.md):
  `agent/turn-stopping`.
- [36 — AI and Jujutsu](36-ai-and-jujutsu.md): native tools + guard, not MCP.
- [38 — multi-agent capacity](38-multi-agent-and-plugin-capacity.md): the
  P0 safety and isolation plan this document builds on.
- `jj help` for 0.46.0: `show`, `file`, `evolog`, `commit`, `edit`, `split`,
  `rebase`, `duplicate`, `revert`, `abandon`, `restore`, `metaedit`, `op`,
  `workspace`, `run`, `bisect`, `fix`, `sparse`, `tag`, `git push`.
