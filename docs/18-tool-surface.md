# 18 — Tool surface (D4: the full first-class set)

**Decision taken:** ship the guard **and** a full first-class `jj` tool set.
This document is its specification.

## Principle

**No tool returns prose.** `jj` is a graph-and-prose CLI by default; an agent
that parses `jj log`'s graph output is an agent that will mis-parse it. Every
tool here returns structured JSON.

This is not a hope — `jj` supports it natively. Verified on 0.46.0:

```
$ jj log --no-graph -T 'json(self)' -r @
{"commit_id":"23ddaf17c6765df20cc8c72319313578741179d5",
 "parents":["3c02384ce157531d74e76017ba5965a72a1c90f8"],
 "change_id":"zwtutzwnststznpzrnkwxvrvumrnslor",
 "description":"",
 "author":{"name":"","email":"","timestamp":"2026-10-10T08:46:02+08:00"},
 "committer":{…}}
```

`json(self)` is a template function, so every `jj log`-shaped read is one
command away from typed data. `jj bookmark list -T '…'` and `jj op log -T '…'`
work the same way.

## Shared conventions

| Convention | Rule |
|---|---|
| Workspace guard | Every tool refuses outside a `jj` workspace with `{error:{code:'NOT_JJ_WORKSPACE'}}`. It never falls back to Git. |
| Identity | Tools **return** both `changeId` and `commitId`; tools **accept** `changeId` (or a revset). Change IDs are stable across rewrites, commit IDs are not ([07](07-jujutsu-core-model.md)). |
| Echo state | Every mutating tool returns the resulting working-copy state, so the model never has to re-read to chain a step. |
| Errors | `{ error: { code, message, hint? } }`, never a raw stderr dump. `hint` carries the next command, mirroring the guard's philosophy. |
| Output size | Reads are bounded by an explicit `limit` with a documented default. Never return an unbounded `jj log`. |
| Descriptions | Each tool's description states the `jj` model in one sentence — `@` is always dirty, history is mutable — because that is the part the model gets wrong. |

## The tools

### Reads

| Tool | Args | Returns | Backing command |
|---|---|---|---|
| `jj_status` | — | `{conflict: bool \| null, revisions: [<jj commit object>]}` | `jj log --no-graph -T 'json(self)' -r '@\|@-'` **plus** `jj log --no-graph -T 'conflict' -r @` |
| `jj_log` | `revset?`, `limit?` | `[<jj commit object>]` | `jj log --no-graph -T 'json(self)' -r <revset> [--limit n]` |
| `jj_diff` | `revset?` | `{files: [{status, path}]}` | `jj diff --summary -r <revset>` |
| `jj_op_log` | `limit?` | `[<jj operation object>]` | `jj op log --no-graph -T 'json(self)' [--limit n]` |

### Mutations

| Tool | Args | Backing command |
|---|---|---|
| `jj_new` | `revset?`, `message?` | `jj new <revset> -m <message>` |
| `jj_describe` | `message`, `revset?` | `jj describe -m <message> -r <revset>` |
| `jj_squash` | `from?`, `into?` | `jj squash --from … --into …` |
| `jj_bookmark` | `action: list\|create\|set\|move\|delete\|forget\|rename\|track\|untrack`, `name?`, `newName?`, `revset?` | `jj bookmark <action> …` |
| `jj_op_restore` | `opId` | `jj op restore <opId>` |

### Hunk-level (the `jj-hunk` bridge)

| Tool | Args | Backing command |
|---|---|---|
| `jj_hunk_list` | `query?`, `revset?` | `jj-hunk list --format json [-r <revset>] [--query …]` |
| `jj_hunk_apply` | `mode: split\|commit\|squash`, `query`, `message?`, `revset?` | `jj-hunk <mode> --query … [-r <revset>] [<message>]` |

## Where the built surface differs from the first draft

The tables above are the **implemented** surface, checked against
`buildToolDefinitions` in `src/tools.ts`. Six fields the first draft specified
are not there, and each omission is deliberate:

| Draft | Now | Why |
|---|---|---|
| `jj_log(includeDiff?)` | absent | A diff per revision multiplies the payload by the log depth. `jj_diff` exists; compose them. |
| `jj_diff(paths?, stat?)` | `revset?` only | `--summary` is what the tool returns; `--stat` and pathsets are unbuilt, and an arg that is accepted but ignored is worse than one that is absent. |
| `jj_squash(keepEmptied?)` | absent | `--keep-emptied` exists in `jj` and is a candidate; it is not wired. |
| `jj_bookmark(remote?)` | absent | `--remote` applies to `list`/`track`/`untrack` only, and the per-subcommand flag divergence is already the sharp edge here. |
| `jj_hunk_list(group?)` | absent | `--group` changes presentation, not content. |
| `jj_hunk_apply(spec?)` | absent | A spec file must live **outside** the working copy or it invalidates its own hunk IDs. `--query` is the supported form; see the two rules below. |

Two shapes also changed to match what `jj` actually emits:

- **The commit objects are `jj`'s own**, in `jj`'s snake_case (`commit_id`,
  `change_id`, `description`, `author`, …), not a curated camelCase projection.
  Normalising would drop fields `jj` adds between versions, and the plugin's job
  is to report the repository, not to have an opinion about its schema.
- **`jj_status` carries `conflict` separately**, because `json(self)` has no
  conflict field and `jj resolve --list` exits 0 either way
  ([13](13-empirical-verification.md) §"Second pass").

Eleven tools — four reads, five mutations, two hunk. The two hunk tools are the reason this project exists; the other
eight exist so the model can orient itself in `jj` without shelling out and
parsing.

## Two rules that make the hunk tools correct

1. **`--query` is the primary input; IDs are not accepted across calls.**
   Measured: appending one comment regenerated every hunk ID
   ([13 §6](13-empirical-verification.md)). A `jj_hunk_list` →
   `jj_hunk_apply` flow that passes IDs is broken by construction whenever the
   model edits anything in between.
   - If the model must pass an explicit selection, accept a **spec object**
     (`{files:{path:{hunks:[i]}}, default:'reset'}`) and write it to a temp
     spec file. Indices are valid only against the immediately preceding list.
   - Prefer teaching `--query`: `added(content:"…")`,
     `changed(path:glob:"src/**")`, composed with `|`, `&`, `~`.
2. **Always preview before mutating.** `jj_hunk_list` with the same `query`
   returns exactly what `jj_hunk_apply` would select. The tool description
   should instruct the model to list first — and `jj_hunk_apply` should reject
   a query that selects nothing rather than reporting a silent success.

## The schema budget

Eleven tools is roughly 1,000–1,500 tokens of schema on **every** request. That is
a real, recurring cost, and it is the main argument against this design.

**Measured, now that the copy exists** ([25](25-prompt-copy.md) §3):

| Component | Tokens (chars ÷ 4) |
|---|---|
| 11 tool descriptions | ≈ 357 |
| argument names + descriptions | ≈ 384 |
| **copy subtotal** | **≈ 740** |
| schema overhead (types, enums, required arrays, tool names) | the remainder |
| **total** | **≈ 1,000–1,500** |

So roughly half the cost is copy and half is structure. That matters for the
staging argument below: dropping five tools removes both halves of their cost,
which is why tiering is the most effective lever.

Three ways to spend it better, in order of preference:

1. **Tier the tools.** Ship `jj_status`, `jj_log`, `jj_new`, `jj_hunk_list`,
   `jj_hunk_apply` first — the five that cover orientation and the reason the
   plugin exists. Add the rest when a real workflow demands them. This is
   compatible with D4: the *design* is the full set; the *rollout* can be
   staged.
2. **Collapse by verb family.** `jj_bookmark` and `jj_op` are already collapsed
   behind an `action` enum. `jj_hunk_apply` collapses three commands behind
   `mode`. Continue that: one `jj_op`-style tool per family rather than one per
   command.
3. **One `jj` tool with a subcommand enum.** Smallest schema, worst
   discoverability — the model has to read one long description instead of
   scanning ten short ones. Not recommended.

## Deliberately not a tool: publishing

`jj git push` is **not** in the set. Publishing is the one operation that
leaves the machine and cannot be quietly undone; it should go through `bash`
where the user sees it in the command stream, or through a future `jj_publish`
tool that requires the same explicit-bypass treatment as
[17](17-bypass-and-approval.md). Creating a bookmark is safe and local; pushing
is not.

## Relationship to the guard

The tools and the guard are **independent**. The guard denies Git; the tools
give the model a good way to do Jujutsu work. Neither requires the other:

- With the guard and no tools, the model uses `bash` + `jj`.
- With the tools and no guard, the model has a good surface but still reaches
  for Git out of habit.

Ship both, but they can land separately.
