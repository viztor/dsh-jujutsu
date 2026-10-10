# 33 — Probe results: the `jj`-side questions

**Method.** Scratch repos under `/tmp`, `JJ_CONFIG` pinned to
`/dev/null:<scratch>.toml` so the user's real configuration is never read.
Toolchain: `jj` 0.46.0, `jj-hunk` 0.5.1. Every claim below is a transcript.

These are the open items that needed no harness plugin to settle — they are
`jj` behaviour, so they could be measured immediately.

## 1. `jj-hunk` version detection

`jj-hunk` has no version flag: `--version` and `-V` both error with
`unexpected argument '--version' found`, and `strings` finds no bare semver
embedded in the binary.

But the **first tier works**:

```
$ cargo install --list | grep -A2 jj-hunk
jj-hunk v0.5.1 (https://github.com/laulauland/jj-hunk#53838e93):
    jj-hunk
```

`cargo install --list` reports both the version *and* the source revision. So
the tiered probe in [26](26-preflight-and-error-taxonomy.md) §A.4 stands, and
tier 1 is stronger than expected: it also confirms the install came from the
pinned revision rather than a crates.io release.

**Residual:** a `jj-hunk` installed by `cargo binstall`, or by copying a binary,
leaves no `cargo install --list` entry. Tier 2 (the capability probe on the
64-hex ID shape) remains necessary, and tier 3 (unknown ⇒ warn and proceed)
remains the honest fallback.

**Spec change:** none. §A.4 is confirmed, with the tier-1 note added.

## 2. Conflicts — `jj new` does **not** escape them

This contradicts a claim made during the integration survey, and it matters
because it was the stated reason for *not* refusing `jj_new` on a conflicted
tree.

```
$ jj new <A> <B> -m merge           # two children of the same parent, both touching f.txt
$ jj log --no-graph -T 'conflict' -r @
true
$ jj resolve --list
f.txt    2-sided conflict
exit=0
$ jj new -m after                   # the supposed escape route
Working copy  (@) now at: xuxnzstz 9b4353c6 (conflict) (empty) after
Parent commit (@-)      : rrnvxylu 30a5f14b (conflict) (empty) merge
exit=0
```

`jj new` **succeeds and propagates the conflict** — the new working-copy commit
is itself marked `(conflict)`. It does not resolve anything and it does not
escape.

**Consequences:**

- Refusing `jj_new` on a conflicted tree does **not** remove a recovery path.
  The recovery is `jj resolve` or `jj abandon`, not `jj new`. The earlier
  justification for leaving `JJ_CONFLICTS_PRESENT` on `jj_new` open is
  **withdrawn**.
- `jj resolve --list` exits **0** when conflicts exist — so exit code alone
  cannot detect them. Use `jj log -T 'conflict' -r @`, as
  [26](26-preflight-and-error-taxonomy.md) §A.8 already specifies.
- A conflict propagates into every subsequent commit until resolved, which means
  an agent that does not notice will keep stacking conflicted commits. That is
  an argument for surfacing the conflict *earlier* than per-call.

## 3. The identity matrix — and a correction to my own correction

The question: with `user.name`/`user.email` unset, which commands produce an
**unpushable** commit? Method: seed commits *with* a real identity, then run the
command *without* one and inspect the resulting author.

| Command (identity unset) | Warns | Author of the result |
|---|---|---|
| `jj new` | yes | **empty** — mints a fresh empty-author commit |
| `jj commit` | yes | **empty** |
| `jj describe -r <existing>` | yes | **preserved** (`real@example.com`) |
| `jj squash --from <rev> --into <rev>` | **no** | **preserved** (`real@example.com`) |

```
$ jj squash --from "$CHILD" --into "$BASE"     # no identity
warnings: 0
$ jj log -T '... author.email()' -r "$BASE"
xrptooyxxvsk base  author=[real@example.com]
```

**This corrects a correction.** An intermediate test appeared to show `squash`
minting an empty author; that reading was wrong — it was inspecting `@-`, which
after the squash was the *newly created empty working-copy commit*, not the
rewritten one. The original survey claim was right: **`jj describe` and
`jj squash` preserve; `jj new` and `jj commit` mint.**

**Consequences for the fail-closed posture in
[26](26-preflight-and-error-taxonomy.md) §A.5:**

- The rule should be stated as **"refuse commands that create a commit"**, not
  "refuse commit-creating operations" loosely. `jj_new` and `jj_commit` are in;
  `jj_describe` and `jj_squash` are out.
- `jj_hunk_apply` stays **in** for all three modes. `split` and `commit` create
  commits; `squash` was not resolved by this probe (the no-op case produced no
  commit to inspect), and the conservative reading costs one prompt.
- The warning text is emitted by `jj new`, `jj commit` and `jj describe` — so a
  warning-based detection in `tools/post-execute` would fire on the *safe*
  commands too. Detection must be by author inspection, not by stderr text.

## 4. What is still open on the `jj` side

| Item | Why it needs more |
|---|---|
| `jj-hunk` version floor when the version is unreadable | needs a 0.5.0 binary; none available here |
| `jj_hunk_apply(mode:'squash')` author behaviour | the probe's no-op produced no commit; needs a case that actually moves a hunk |
| `JJ_CONFLICTS_PRESENT` on `jj_new` | now has an answer (refuse — `jj new` does not escape), but the *message* needs a verified remedy string |
| Older `jj` (< 0.46) behaviour | no older binary available |
