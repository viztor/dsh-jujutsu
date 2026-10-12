# 14 — Decision log

Decisions that shape the build. Each has a recommendation; none is final until
answered. The numbering matches [`SPEC.md`](../SPEC.md) §12.

---

## D1 — Is Git blocked outright, or only inside a `jj` workspace?

**Recommendation: block only inside a `jj` workspace; be invisible elsewhere.**

The plugin is installed into a profile that is used across many unrelated
repositories. A global Git block would be hostile and would make the plugin
uninstallable in practice.

**Measured support:** detection is cheap and unambiguous — `.jj/` is a
directory in every workspace layout, including secondary ones
([13 §1, §2](13-empirical-verification.md)).

---

## D2 — Are read-only Git commands denied too? _(the most contestable call)_

> **RESOLVED.** The call: deny by default, but **require an explicit bypass** —
> the user asked whether that was possible. It is, natively: the guard returns
> `{kind:'ask'}` and the harness's approval channel prompts for a one-call
> grant. Fully specified in [17](17-bypass-and-approval.md).
>
> Measured support for denying: `git status` in a colocated repo does not just
> omit `jj` information, it reports a **different** state — `?? b.txt` to Git
> while `jj status` says `A b.txt` ([13 §4](13-empirical-verification.md)).
> The model is actively misled, which settles the "they're harmless reads"
> argument against denying.

The candidates:

|                      | Deny `git status` / `git log` / `git diff`                                                                                                                                                                                                                                                                | Allow them |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Argument for**     | They are precisely the commands that mislead. `git status` in a colocated repo reports the working tree as if it were a Git working tree; `git log` shows exported commits but not `@`; neither shows the change IDs the agent needs. The model builds a wrong mental model from a command that "worked". |            |
| **Argument against** | They are harmless — they mutate nothing. Denying them is paternalistic and adds friction on every orientation step. A model that can look but not touch may still be steered by context injection.                                                                                                        |            |

**Recommendation: deny them, with a denial that is a teaching moment** —
`git status` → _"This is a Jujutsu workspace; `git status` describes a Git
working tree that does not exist here. Run `jj status`."_ The cost is one extra
step; the benefit is that the model never forms the wrong model of the repo.

**Counter-consideration:** this is the decision most likely to annoy a user who
legitimately wants to peek with Git. If denied, it should be a config switch
(`readOnlyGit: 'deny' | 'allow'`), defaulting to deny.

---

## D3 — `jj-hunk` provisioning

> **RESOLVED: offer to install via cargo.** Specified in
> [19](19-jj-hunk-provisioning.md). The install goes through the same approval
> channel as D2's bypass — it is a system mutation, not a config toggle — and
> the source must be pinned to a reviewed revision rather than a branch.

| Option                        | Consequence                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detect only** (recommended) | If `jj-hunk` is missing, refuse hunk operations and print the exact install line. Safe, no surprises, no toolchain dependency.                               |
| Offer to install              | `cargo install --git https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk`. Requires a Rust toolchain; takes ~40 s; mutates the user's `~/.cargo/bin`. |
| Bundle a binary               | Per-platform binaries, pinned, shipped in the package. Highest maintenance; most reliable.                                                                   |

**Recommendation: detect-only for v0.1.** Installing a Rust binary from inside
an agent is a decision the user should make deliberately, not one the plugin
makes on first use.

**Measured:** `cargo install --git …` succeeded in 37 s on this machine, so
"offer to install" is viable if wanted later.

---

## D4 — Policy-only, or first-class `jj` tools?

> **RESOLVED: both — the full first-class tool set.** Eleven tools, specified in
> [18](18-tool-surface.md), built on `jj`'s native `-T 'json(self)'` templates
> (verified on 0.46.0) so no tool ever returns prose.
>
> The schema budget is the real cost — ~1,000–1,500 tokens on every request.
> The design is the full set; the _rollout_ can still stage the five highest-value
> tools first without changing the design.

|              | Policy only (v0.1)           | First-class tools (v0.2)                           |
| ------------ | ---------------------------- | -------------------------------------------------- |
| Surface      | one listener                 | ~8 `defineTool` registrations                      |
| Model gets   | denial text                  | structured JSON: change IDs, bookmarks, hunk lists |
| Failure mode | model parses terminal output | typed errors                                       |
| Risk         | low                          | more to get wrong; each tool is a new contract     |

**Recommendation: policy first, tools second.** The guard is what stops active
harm and it is small. Tools are a genuine improvement but they are additive —
nothing in the guard's design blocks them later.

---

## D5 — Detection scope

**Recommendation: per tool call, cached per workspace root, invalidated on
observed `jj git init` / `jj workspace add` and at session start.**

Per call because a session can move between workspaces. Cached because
`ctx.fs.stat` on every `bash` call is a needless cost. The invalidation rule is
the part that needs care: a session that starts outside a `jj` repo and enters
one must start enforcing (acceptance criterion 7 in
[12 §H](12-risks-and-open-questions.md)).

---

## D6 — Guard `read` / `write` / `edit` on `.jj/` internals?

> **RESOLVED: yes.** Writes into `.jj/**` and `.git/**` are denied; reads are
> allowed. `.jj` holds the operation log and the working-copy state, and it is
> less recoverable than `.git`. The denial points at `jj op restore`.
> Implemented as the same `tools/pre-execute` listener, matching `exec.name` in
> `{read, write, edit}`. See [`SPEC.md` §5.7](../SPEC.md).

**Recommendation: yes.** `dsh-tool-fs` tools can address any path in the
workspace. `.jj/` holds the operation log and the working-copy state; a stray
write there is unrecoverable in a way that a stray write to `.git` is not.
Deny writes to `.jj/**` and `.git/**` with a message pointing at `jj op restore`.

Reads are harmless and should be allowed.

---

## D7 — `jj` version floor

**Recommendation: 0.46.0.** It is what every measurement in
[13](13-empirical-verification.md) was taken against, and the features the
design leans on (colocation by default, `jj sparse`, `jj workspace`) are all
present.

---

## D8 — Naming

> **CORRECTED.** The package and plugin id are `dsh-jujutsu`, and prose says
> "Jujutsu (`jj`)". The original spelling — _Jijitsu_ — was a misspelling, not
> branding, and this decision initially preserved it on the assumption that a
> project name is the author's to choose. It is not the author's to _keep_ when
> it is wrong: a wrong name in a package id is permanent and public, and every
> downstream identifier inherits it.
>
> The lesson is narrower than "spell things right". The evidence was already in
> hand — the thread used one spelling, the tool it meant uses another — and the
> correct move was to **ask**, not to resolve the ambiguity silently in the
> direction of least disruption.
>
> Scope of the correction: everything. The transcript that used the misspelling
> was distilled into [`research/digest.md`](../research/digest.md) and the raw copy
> deleted. The verbatim _quotes_ of that conversation inside the docs remain —
> rewriting a quote would falsify the record — and they had to be restored after a
> blanket rename briefly corrupted them.
>
> The naming distinction that does matter is the one the thread got wrong for
> nine turns: **Jujutsu is a version-control system**, not Jiu-Jitsu the martial
> art ([01](01-framing-and-intent.md)).

---

## Resolutions from the test plan

[`docs/20-test-plan.md`](20-test-plan.md) §d.10 left six rows OPEN because the
docs contradicted each other or were silent. Resolved here; the test plan now
points at these.

### R1 — `xargs` is a wrapper. Strip it and recurse.

`xargs git add` really does run `git add`. `docs/15` §2 (strip `xargs`) wins
over §4's caution, because §4's worry — "treating `xargs` as a wrapper creates
false positives on `xargs rm`" — does not apply to a **name-based** recursion:
`xargs rm` recurses to `rm`, which is not `git`, so it is allowed anyway. There
is no false positive to avoid, and stripping catches a real invocation.

Also handles `xargs -n1 git add` (flags before the program).

**Confidence stays `low`** — `xargs` can also exec a shell (`xargs sh -c …`),
and the recursion covers that case only because the shell body is parsed too.

### R2 — `timeout` joins the wrapper list.

`timeout 5 git status` must resolve to `git`, not to `timeout`. The list gains
`timeout` (consuming its duration argument), plus `setsid`, `stdbuf`, `chrt`
and `ionice` for the same reason. The full list is now:

> `env`, `command`, `nohup`, `time`, `sudo`, `exec`, `nice`, `ionice`, `chrt`,
> `setsid`, `stdbuf`, `timeout`, `xargs`

Each consumes its own flags and values before the real program begins. This
list is a maintained asset, not a constant — it is the kind of thing that goes
stale silently.

### R3–R5 — one generic fallback reason for any unmatched `git` form

Bare `git`, `git --version`, and `git <unknown-subcommand>` are all denied by
the rule, and none has a table row. They share one fallback message:

> This is a Jujutsu workspace; `git` is not used here. Run `jj` instead —
> `jj help` lists the commands, and `jj log` shows history with change IDs.

The verb mapper therefore needs three tiers, not two:
**exact row → verb-family row → generic fallback.** A `git` invocation must
never fall through to allow simply because its subcommand is unrecognised.

### R6 — flags win over the verb, always

`readOnlyGit: 'allow'` must not open a hole. A verb is read-only only in its
**listing form**:

| Verb                                                              | Read-only forms                      | Mutating forms                               |
| ----------------------------------------------------------------- | ------------------------------------ | -------------------------------------------- |
| `branch`                                                          | _(no args)_, `-a`, `-v`, `--list`    | `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `<name>` |
| `tag`                                                             | _(no args)_, `-l`, `--list`          | `-d`, `-a`, `-m`, `<name>`                   |
| `remote`                                                          | `-v`, `show`                         | `add`, `remove`, `set-url`, `rename`         |
| `config`                                                          | `--get`, `--get-all`, `--list`, `-l` | `<key> <value>`, `--unset`, `--add`          |
| `stash`                                                           | `list`, `show`                       | everything else                              |
| `status`, `log`, `diff`, `show`, `blame`, `rev-parse`, `describe` | always                               | —                                            |

**Rule: classify on verb **and** flags. Anything not positively identified as a
listing form is treated as mutating** and is denied even when
`readOnlyGit: 'allow'`. Fail closed on this one axis, because the cost of a
wrong allow is a silently rewritten repository.

### R7 — `git init`'s replacement is not actionable in place

Measured: inside an existing `jj` workspace, `jj git init` exits 1 with
`Error: The target repo already exists`. The denial must not tell the model to
run it. Correct message:

> This is already a Jujutsu workspace — there is nothing to initialise. To
> create a _new_ Jujutsu repo elsewhere, run `jj git init <directory>`.

---

## Resolutions from the evasion analysis

[`docs/21-guard-evasion.md`](21-guard-evasion.md) measured 64 commands against a
prototype parser and a logging `git` shim. Three decisions follow.

### R8 — No `PATH` shim. No `GIT_DIR` manipulation.

The idea was to put a failing `git` earlier on `PATH`. **Rejected, and the
reason is not the obvious one.** Verified:

| Fact                                                                                             | Consequence                                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `jj git fetch` and `jj git push` **exec the external `git` program** (argv captured by the shim) | A shim breaks jj's own remote operations — the carve-out we spent effort preserving |
| `git-lfs` execs `git version`, `git rev-parse --git-dir`, `git remote`                           | Breaks LFS for every non-agent tool in the same shell                               |
| `bash -lc`, `env -i`, `PATH=/usr/bin:$PATH`, an absolute path all bypass it                      | Verified — each printed the real Git version with the shim first on `PATH`          |
| `jj --config git.executable-path=…` restores jj's fetch                                          | The shim is not even self-consistent                                                |

A shim is both more invasive _and_ less effective than the text rule, which
reads the program name and is therefore immune to `PATH` games. Same verdict for
`GIT_DIR`/`GIT_WORK_TREE` manipulation: same bypasses, more collateral, worse
error message.

### R9 — The `rm -rf .git` hole is real, and it belongs to D6

Verified end to end: in a colocated repo it leaves jj unable to open the
repository at all, and no jj command can recover it
([21 §e](21-guard-evasion.md)). It is not a Git invocation, so the Git-verb
guard allows it by design — correctly, because that guard's value is that it
resolves the _program_ rather than scanning for a token.

It is therefore specified as a **separate predicate under D6**
([`SPEC.md` §5.7](../SPEC.md)): a destructive verb targeting the exact component
`.git` or `.jj`. Exact-component matching keeps `.gitignore`, `.gitattributes`,
`.gitkeep` and `.github/` out. Unresolvable paths (containing an expansion)
**ask**, never allow.

### R10 — Read-only Git stays on `pre-execute`. Post-execute `{kind:'block'}` declined.

The analysis recommended running harmless read-only Git commands and then
replacing the result with corrective feedback via
`tools/post-execute {kind:'block'}`. **Declined**, for two reasons:

1. It contradicts the D2 decision. The user asked for _deny by default with an
   explicit bypass_. Post-execute block is neither — it runs the command and
   then rewrites history.
2. The point of denying `git status` is that its **output is the harm**. Letting
   it run and then withholding the output costs a process spawn to arrive at the
   same place as a `pre-execute` deny.

The channel is not useless — it is the right tool for "the command ran, and
here is why that was wrong". It is simply not the right tool for a rule that
knows the answer before dispatch.

---

## Resolutions from the integration survey

[27](27-integration-surfaces.md) mapped the whole extension surface — 90 events,
~95 services. Four decisions follow; the detail is in
[28](28-teaching-and-interaction-surfaces.md),
[29](29-state-config-and-sandbox-surfaces.md) and
[30](30-lifecycle-and-observability-surfaces.md).

### R11 — Preflight moves to `agent/created`

Not `session/created`, which fires first but is a synchronous `emit`: async work
there is not awaited and rejections are only logged. `agent/created` is `serial`
and **awaited before session creation resolves**, and `SessionHeader.cwd` is
already available — no tool call needed to learn the root.

Two consequences. The lazy trigger this repo had specified is really _once per
session that touches `jj`_, and it puts 5–8 shell spawns on the **first** `jj`
tool call; behind a single `.jj` stat gate, a plain-Git session costs one stat.
And `try/catch` becomes load-bearing a **second** time, with a larger blast
radius than the guard's: a throw in an `agent/created` listener fails session
creation, not one tool call.

### R12 — The bypass policy check is three-term, not two

`overrideOf(session) ?? approval.config.policy ?? 'ask'`. An earlier draft had
`overrideOf(session) ?? 'ask'`, which is wrong because `overrideOf` deliberately
excludes the deployment default. Under the shipped `danger-full-access` mode the
base composition sets `policy: 'never'`, so the two-term form concludes `'ask'`
while the service short-circuits to `'rejected'` — and `dsh-tools` substitutes
_"the user rejected tool bash"_, which is exactly the failure
[17](17-bypass-and-approval.md) exists to prevent. Fixed there.

### R13 — Teaching splits; the bypass does not become a question

- **`skills` — USE, for the manual only.** Rule and state stay in
  `ctx.systemPrompt`; the `jj` manual moves to a `jujutsu` skill. Strict
  reduction, no new failure mode.
- **`commands` — USE, user-only by design.** `/jj bypass on|off` and
  `/jj install-hunk`. A plugin cannot invoke a command either; that is the point
  for a permission grant.
- **`userQuestions` — USE for the `jj-hunk` install offer**, which needs three
  answers where `approval` has no answer channel at all.
- **`approval` stays for the guard's bypass.** `userQuestions` throws
  `DELEGATED_CALLER` for an agent owned by another, so a subagent's `git commit`
  would break. The two channels differ structurally; do not merge them.
- **`storage` — REJECT.** There is no per-workspace store: the only durable
  medium is global to the DSH home, and a `.jj`-root-keyed table would silently
  widen a grant to every project under it.
- **Config — mark every field `.volatile()`** or the whole row is dropped from
  Settings, but do not claim the UI renders controls: `autoGenerate` has no
  shipped consumer, and real controls need a browser half this plugin does not
  have.

### R14 — The `policyWorkspaceRoot` unknown is closed

`docs/24` §6 #7 asked whether the guard can read the same value the `bash` tool
computes. **Yes** — both call the same pure
`SandboxPolicyService.resolve({session: exec.agent.session})`. Sharper: `resolve`
derives `workspaceRoot` from `session.header.cwd` **and nothing else** whenever
the session has a cwd, so in every ordinary session the two agree by
construction and the service is load-bearing only for a cwd-less session. One
residual to mirror: gate on `ctx.shell.sandboxMode === undefined`.

---

## Decisions taken (not open)

| Decision                          | Rationale                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loud guard, no silent translation | Both required by the user (turn 9) and forced by the platform — `tools/pre-execute` excludes input rewriting ([11 §1](11-verified-dsh-api-contract.md)). |
| Use `ctx.fs`, never `node:fs`     | The service is the sandbox and policy boundary ([05](05-filesystem-seam.md)).                                                                            |
| `--query` over saved hunk IDs     | IDs regenerate on any edit, measured ([13 §6](13-empirical-verification.md)).                                                                            |
| Fail open on detector errors      | A broken detector must not block the user's shell ([SPEC §8](../SPEC.md)).                                                                               |
| No client/UI half                 | Nothing to render.                                                                                                                                       |
