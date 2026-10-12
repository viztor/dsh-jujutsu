# 12 — Risks and open questions

**Status:** the decisions that are still open, and the ways this can go wrong

## A. The design tension nobody resolved

Turns 2–9 want Git **blocked**. Turns 12–13 want a **colocated** workspace
where editors, Turborepo, and `gh` keep reading `.git`. Those cannot both be
naive absolutes.

The only coherent reading:

> Git is blocked **for the agent's own commands**; `.git` stays **current** for
> every other tool, maintained by `jj`'s automatic export.

If that is right, then:

- the guard must not fight `jj git export` (a `git`-free command, fine), but
- it must allow whatever keeps `.git` fresh, and
- it should probably _run_ the export before build/`gh` commands rather than
  deny them — see [10](10-workflow-compatibility.md).

**Decision needed.** Write it down before writing the guard, because the guard's
allow-list falls out of it.

## B. Matching Git in bash command text

This is the weakest technical link in the project.

**False negatives** (Git gets through):

- `command git status`, `\git commit`, `env FOO=1 git push`
- a shell function or alias named something else
- `sh -c 'git commit'`, `xargs git`, `find … -exec git …`
- a script or Makefile target that shells out to Git
- `node -e "require('child_process').execSync('git commit')"`
- `git` reached through `$PATH` manipulation or an absolute path

**False positives** (legitimate work denied):

- `echo "remember to git commit"` — a string, not an invocation
- `jj git export`, `jj git fetch`, `jj git push` — `git` is a `jj` subcommand
- `grep -r git src/`
- documentation that quotes a Git command

A regex on command text cannot be correct. Options, roughly in order of
soundness:

1. **Deny Git, allow `jj git *`** — parse the command into shell segments
   (respecting quotes) and inspect the head of each. Handles the common cases
   and the `jj git` carve-out, misses the exotic ones.
2. **Make Git fail at the source** — put a `git` shim earlier on `PATH` that
   exits non-zero with a message pointing at the `jj` equivalent. This is
   robust and simple, and it works even for the exotic cases. It is also
   invasive: it changes the user's environment, and it would break the
   `jj git export` bridge and every non-agent tool in the same shell.
3. **Both** — the shim for enforcement, the guard for a good error message.

**Decision needed:** how much evasion are we defending against? An agent is not
adversarial; it is a cooperative model that emitted `git commit` out of habit.
Option 1 plus a clear message probably suffices, and it fails _open_ rather
than breaking the user's environment.

## C. `jj-hunk` provisioning

`jj-hunk` is a Rust binary that may not be installed. The plugin needs a
position on:

- **Detect only** — refuse hunk operations with install instructions. Safest.
- **Offer to install** — the pinned git build, `cargo install --git
  https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk`. Not
  `cargo install jj-hunk`: the crates.io release is behind and its CLI differs.
  Installing a toolchain-dependent binary from inside an agent is a real
  decision.
- **Bundle** — ship a pinned binary per platform. Highest maintenance.

Also: which version is the floor? The hunkset language and the ID contract
both changed at 0.5.1.

## D. Hunk IDs are ephemeral

`jj-hunk` IDs are SHA-256 over the materialized comparison. Any change to the
revision or the working copy regenerates **all** of them. An agent that lists
hunks in one turn and applies a spec in the next will produce stale selections
whenever anything changed in between.

**Mitigation:** prefer `--query` expressions (stable in intent) over saved IDs;
always re-`list` immediately before applying; treat a spec file as valid for one
step only.

## E. Detection scope

Per execution? Per session? Per workspace? A session can touch several
workspaces, and `jj workspace add` creates additional working directories whose
`.jj` entry is a **file**, not a directory. Cache invalidation matters: a
`jj git init` mid-session must switch the guard on.

## F. First-class tools vs policy over `bash`

The conversation assumes policy-over-bash throughout. But an agent driving `jj`
by parsing terminal output is fragile — `jj log` is a graph, `jj status` is
prose. A first-class tool set (`jj_status`, `jj_new`, `jj_squash`, `jj_hunk_list`,
…) that returns structured JSON would be more reliable and is what the harness's
`defineTool` surface is for.

This is the largest unmade product decision. It roughly doubles the surface
area but removes a whole class of parsing bugs.

## G. The guard's blast radius

A wrong denial is worse than a missed one: it blocks the user's work and the
model then flails. Every rule needs an escape hatch, and the denial text has to
be _actionable_ — naming the exact replacement command, as the conversation
insists (turn 3).

Also consider: should the guard cover `read`/`write`/`edit` too, e.g. refusing
to let the agent hand-edit `.jj/` internals? Probably yes — corrupting `.jj`
is unrecoverable in a way that corrupting `.git` is not.

## H. What "all of the workflow execute smoothly" needs to mean

Acceptance criteria do not exist yet. A defensible first set:

1. In a non-`jj` repo, the plugin is **invisible** — no denial, no added
   context, no measurable latency.
2. In a `jj` repo, `git commit` / `git checkout -b` / `git branch` are denied
   with a correct, actionable `jj` replacement.
3. `jj git export` and `jj git push` still work.
4. `jj-hunk list` → `split` round-trips on a two-change fixture file, with the
   rest of the changes left in the working copy.
5. Colocated repos keep working for an external `gh` invocation after export.
6. The plugin never writes to `.jj/` or `.git/` directly.
7. A session that starts outside a `jj` repo and later enters one starts
   enforcing.

Each of these is testable with a fixture repo and a scripted tool call. None of
them is testable by reading the conversation.

## I. Provenance

Every architectural claim in the conversation came from a model that does not
have this harness's source. The parts that survived verification are the parts
about **`jj` itself** (public documentation) and the **shape** of the tool
policy seam. Everything specific — package names, API calls, config files,
script names — had a high error rate.

Rule for this repo: **no design decision cites the conversation.** Cite
[11](11-verified-dsh-api-contract.md), the `jj` docs, or the `jj-hunk` README.
The conversation is a source of questions.
