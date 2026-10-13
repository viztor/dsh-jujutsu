# 19 — `jj-hunk` provisioning (D3: offer to install)

**Decision taken:** when `jj-hunk` is missing, the plugin **offers** to install
it, and installs only on an explicit yes.

## Why this needs its own design

`jj-hunk` is not a library — it is a Rust binary that may not exist on the
machine. Every hunk-level capability in [18](18-tool-surface.md) depends on it.
The failure has to be graceful, and the remedy has to be deliberate: installing
a binary is a system mutation with a supply-chain surface, not a config toggle.

## Detection

Three steps, cheapest first:

1. `jjHunkPath` from config, if set — probe it with `--help`.
2. `jj-hunk` on `PATH` — resolve once at load, cache per session.
3. Neither → the bridge is **unavailable**, and every `jj_hunk_*` tool returns
   `{error:{code:'JJ_HUNK_MISSING', message, hint}}`.

Detection must never block plugin load. A missing binary degrades two tools; it
does not disable the guard.

## The offer

**Implemented.** This section described the flow for several commits while
`hunkInstall` was declared, typed, documented in the README, and read nowhere —
the setting existed in every sense except behaviour. `src/hunk.ts` now carries it:
`missingBinary` for the offer, `offerInstall` for the question, and a
session-keyed map for the "ask once" rule. `test/hunk-install.test.ts` covers the
five branches.

Modelled on the approval design in [17](17-bypass-and-approval.md) — the install
is a mutation, so it needs an explicit yes — **but not through `approval`.**

`approval.request` returns only `allowed-once | rejected | cancelled |
unavailable`: there is no answer channel, so a three-way choice is impossible.
`ctx.userQuestions.ask(request)` is a **public service method**, not gated behind
the `ask_user` tool, and takes a structured request
(`{id, question, options:[{label, description}], multiSelect?}`). It is the right
channel here ([28](28-teaching-and-interaction-surfaces.md) §3):

```
jj_hunk_list called
  └─ jj-hunk not found
       ├─ hunkInstall === 'never'  → error with the install command, stop
       ├─ cargo not on PATH        → error naming the Rust toolchain, stop
       └─ otherwise                → ask:
            "Install jj-hunk? (Rust, ~40 s, builds from a pinned revision)"
              [ Install now ]  [ Show me the command ]  [ Never ask again ]
                ├─ install → verify → retry the call once
                ├─ show    → return the command, stop
                └─ never   → remember for the session, return the command, stop
```

- **Ask once per session**, not once per call. Cache the answer.
- **Retry once** after a successful install. Not a loop.
- **Never install in the background** or on plugin load. The user asked for a
  hunk operation; that is the moment the question is meaningful.
- **Fall back to the `hunkInstall: 'never'` path** if the ask fails closed —
  `userQuestions` throws `CALLER_NOT_LIVE`, `DELEGATED_CALLER` (the agent is
  owned by another) or `NO_PROVIDER`. `DELEGATED_CALLER` is the one that will
  actually happen: a subagent asking for a hunk split cannot raise a question,
  and must get the install instruction instead of an error about asking.
  Note that "owned" means **a subagent**, not a preset: a preset-scoped root
  agent passes the gate, so the offer works in a preset session
  ([32](32-probe-results-teaching.md) §Q5).
- **Pass `agent` in the request.** It is mandatory: omit it and the bridge drops
  the event and the ask fails with `NO_PROVIDER`.

## The command

Upstream's README is explicit that the crates.io release is behind, so the git
form is the supported one:

```bash
cargo install --git https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk
```

**Measured on this machine:** 37.25 s, installing `jj-hunk v0.5.1` to
`~/.cargo/bin/jj-hunk`.

**Pin it to a tag.** A branch-tracking `cargo install --git` builds whatever
`main` is at that moment, and a `cargo install` runs the repository's build
scripts. The command above is pinned; the reason to keep it that way is that two
users following an unpinned instruction a week apart get different binaries.

```bash
cargo install --git https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk
```

A tag rather than a raw `<sha>`: it names the same commit and says what it is.
`v0.5.1` is what this plugin is written and tested against, and it is what CI
installs.

### Do not use `cargo install jj-hunk`

The published crate is the **same project** — same repository URL, same
description — and it is **two minor versions behind**:

| Source    | Newest                          | CLI                               |
| --------- | ------------------------------- | --------------------------------- |
| crates.io | `0.3.0` (plus `0.1.1`, `0.1.0`) | `jj-hunk list --format <FORMAT>`  |
| git tags  | `v0.5.1`                        | `jj-hunk list --query <QUERYSET>` |

That is not a cosmetic difference. Installing from crates.io produces a binary
that **rejects every call this plugin makes**:

```
jj-hunk exited 2: error: unexpected argument '--query' found
Usage: jj-hunk list --format <FORMAT>
```

It is also the command a reader reaches for first, because the crate has the right
name and the right repository URL. This was learned by watching CI fail on it
after installing from crates.io — the bridge had never been exercised in CI
before that, so nothing had caught it.

If a released version catches up **and** carries the `--query` interface, prefer
`cargo install jj-hunk --version <exact>` and drop the git form. Catching up on
the version number alone is not enough; the interface is the thing that matters.

`cargo binstall --git …` would be faster (prebuilt binary, no compile), but
`cargo-binstall` is not present on the development machine and adds a second
missing-tool problem to a plugin whose whole job is reporting missing tools
clearly. **Still UNVERIFIED** — deliberately, as a future optimization rather than
an untested step in the install path.

## Failure modes

| Situation                                      | Behaviour                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cargo` missing                                | Refuse, name the Rust toolchain (`rustup`), do not attempt anything                                                         |
| Install exits non-zero                         | Surface the tail of stderr in `hint`; do not retry                                                                          |
| Install succeeds, `~/.cargo/bin` not on `PATH` | Resolve the absolute path from `cargo install`'s output and use it for the session; tell the user how to add it permanently |
| Install succeeds, `--help` probe fails         | Treat as missing; report the probe failure, do not loop                                                                     |
| Version installed is < 0.5.1                   | Warn: the ID contract changed at 0.5.1 and older specs have no legacy fallback                                              |

## Config

```ts
jjHunkPath:   z.string().default('jj-hunk'),
hunkInstall:  z.union([z.const('ask'), z.const('never'), z.const('auto')]).default('ask'),
```

- `ask` (default) — offer, install on yes.
- `never` — CI stance: report the missing dependency, install nothing.
- `auto` — install without asking. **Available, not default.** It is only
  defensible for a machine the user owns and has already consented on; a plugin
  that silently compiles and installs a binary the first time a model asks for
  a hunk split is a plugin that will surprise someone badly.

## What the plugin must not do

- Fall back to `jj split -i`. It needs a TTY, and a headless agent driving it
  will hang rather than fail.
- Reimplement hunk selection in TypeScript. The hunkset language and the
  comparison-bound ID contract are upstream's to own; a second implementation
  is a second set of bugs.
- Install without asking, unless the user set `auto` themselves.
