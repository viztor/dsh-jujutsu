# 08 — `jj-hunk`

**Source turn:** 10
**Status:** the conversation's three subcommands are real; its framing of *why*
is right and its surface is much thinner than the real tool's

## The problem it solves

Native `jj` rewrites history at commit and file granularity (`jj split`,
`jj squash`), but splitting *within* a file wants an interactive diff editor
(`jj split -i`). An interactive TUI is a dead end for a headless agent: there
is no terminal to drive.

`jj-hunk` is a separate Rust binary that performs the same selections
non-interactively. That is the entire reason a DSH plugin can drive `jj` at
hunk granularity at all — and the reason this project is "JJ **+ jj-hunk**"
rather than just "JJ".

## The real surface

Read from the upstream README (`laulauland/jj-hunk`, MIT):

| Command | Result |
|---|---|
| `jj-hunk list` | Preview hunks (default `--format json`) |
| `jj-hunk split [selection] "message"` | Put the selection in the first commit; leave the rest in the other change |
| `jj-hunk commit [selection] "message"` | Commit the selection; leave the rest in the working copy |
| `jj-hunk squash [selection]` | Move the selection into the parent commit |

**Three ways to express a selection** — and the conversation only mentions the
third:

1. **Hunkset query language** — `--query 'added(content:"timeout")'`
2. **JSON spec** — `--spec-file timeout.json`, or inline / stdin
3. **YAML spec** — the same spec, hand-editable

Predicates: `changed()`, `added()`, `removed()`, `renamed()`, `mode_changed()`,
`binary_changed()`, `all()`, `none()`, `id("hunk-<64 hex>")`.
Pattern modifiers: `substring:`, `exact:`, `glob:`, `regex:`.
Composable with `|`, `&`, `~`, and parentheses.

`jj-hunk list --spec-template --format yaml` emits an ID-based starting spec —
the natural bridge for an agent that wants to propose a split and let a human
or a later step confirm it.

## What the conversation got right

- **`jj-hunk split`, `jj-hunk squash`, `jj-hunk list`** — all real. **VERIFIED.**
- **"assigns stable IDs to each patch chunk so they can be parsed and
  manipulated programmatically"** — real: every hunk carries
  `id: "hunk-<64 lowercase hex>"`, a SHA-256 over the materialized comparison.
  **VERIFIED**, with an important caveat below.
- **"exports hunk distribution diffs directly into json or yaml"** — real:
  `list --format json|yaml`. **VERIFIED.**
- **"bypasses the TUI completely"** — the point of the tool. **VERIFIED.**

## What the conversation got wrong or missed

| Claim | Reality |
|---|---|
| "`jj-hunk` (or `jj-hunk-tool`)" | The tool is `jj-hunk`. No `jj-hunk-tool`. |
| IDs are "stable" | **They are comparison-bound.** The same comparison yields the same IDs, but *any* change to the revision or working copy regenerates all of them. A saved spec is invalidated by the next edit — "do not reuse a saved ID after a revision or working-copy change" (upstream README). An agent must re-`list` before every selection, not cache IDs across turns. |
| Selection is per-hunk or per-line | **Hunks select complete text blocks, not individual matching lines.** Two unrelated edits sharing one block cannot be separated. The agent must preview before applying. |
| `jj-hunk commit` | Never mentioned. It is the one that maps to "commit just this fix and leave the rest in the working copy" — probably the most useful of the three for an agent. |
| Hunkset query language, aliases, `--spec-template`, `-r <revset>` | Never mentioned. The query language is the highest-leverage surface for a tool-calling model: it is a *structured expression* the model can compose, rather than an index list it must first fetch. |
| Installability | `jj-hunk` is a Rust binary: `cargo install jj-hunk`, or `cargo binstall --git https://github.com/laulauland/jj-hunk jj-hunk` because the crates.io release is behind. The plugin must detect or provision it. |
| Unsupported inputs | Copies, conflicts, symlinks, trees, and submodules produce explicit errors. A plugin must not route those at `jj-hunk`. |
| Platform | Occurrence IDs currently require a **Unix** platform (executable state is part of the comparison). |

## Corrections from hands-on use (`jj-hunk` 0.5.1)

Found by exercising the binary directly; all are constraints on the bridge in
[18](18-tool-surface.md).

| Finding | Consequence |
|---|---|
| `--query` **cannot** be combined with `--files`, `--include`, or `--exclude` — it errors: *"the argument '--query <QUERY>' cannot be used with '--include <INCLUDE>'"* | File scoping must go **inside** the query via `path:`. A bridge that builds `--query` and `--include` together will fail. |
| The `file:` argument parses but **never matches** in 0.5.1 (0 hunks for `file:"*"`, `file:glob:"*"`, `file:regex:".*"`) | Use `path:`. Do not build selection on `file:`. |
| `path:`'s **default modifier is glob**, not substring | `path:"server.js"` matches nothing; `path:"**/server.js"` or `path:exact:"server.js"` is needed. |
| A valid query that selects nothing is a no-op for split, commit, and squash | The **upstream README** says this, and it is true — which is the problem. Measured on 0.5.1: an empty `--query` exits **0** with `{"files":[]}`, and an empty query on `split` exits **0** and does nothing. A **stale spec exits 0 and creates an empty commit** carrying the user's message while leaving every change uncommitted. A multi-revision revset (`-r 'all()'`) exits **0** and silently diffs the merged set. **`jj-hunk` reports success on failure**, so the bridge must pre-check every one of these and turn them into hard errors ([26](26-preflight-and-error-taxonomy.md) §B.1). |
| A spec file written **inside** the repo invalidates its own hunk IDs and makes `--spec-file` produce an empty commit | Spec files must be written **outside** the working copy (e.g. a temp dir). This is a hard rule for the bridge. |
| `--version` | `jj-hunk` has **no version flag** — `--version`, `-V` and `version` all error, and no version string is embedded. Version detection must be tiered (`cargo install --list` → capability probe → unknown ⇒ warn and proceed). The weakest check in the plugin. |
| `substring:` / `exact:` / `glob:` / `regex:` are **value prefixes**, not field names | `added(substring:"x")` errors with *unknown field*; the form is `added(content:substring:"x")`. |

The pattern-modifier line above is therefore right as *value* syntax and wrong
if read as field syntax.



1. **The plugin is a *translation layer* over a CLI, not an implementation.**
   Do not reimplement diff parsing. Shell out to `jj-hunk`, parse JSON.

2. **IDs are ephemeral; queries are not.** An agent flow that caches hunk IDs
   across turns will break. Prefer `--query` expressions composed from the
   change description, and re-list when a spec is unavoidable.

3. **`--spec-template` is the confirmation affordance.** "Here is the split I
   propose" — emit the spec, let the next step apply it. This pairs naturally
   with the loud-guard philosophy in
   [02](02-git-blocking-at-tool-call-level.md): show the user what will happen.

4. **The verb mapping in [02](02-git-blocking-at-tool-call-level.md) should
   point here.** `git add -p` and "split this change" are exactly the gestures
   `jj-hunk split` / `commit` / `squash` replace.

## Open questions

- Does the plugin expose `jj-hunk` as its own tool (`jj_hunk_list`,
  `jj_hunk_split`), or only mention it in denial messages? Given that the
  output is structured JSON and the selection language is composable, a
  first-class tool looks right — but it is a second tool surface to maintain.
- How is `jj-hunk` provisioned on a machine that does not have it? Detect →
  instruct → or install? Installing a Rust binary on a user's machine from
  inside an agent is a significant decision.
- Which `jj-hunk` version is the floor? The hunkset language and the ID
  contract both changed at 0.5.1 ("releases before this contract used
  content/context hashes; regenerate saved specs").
