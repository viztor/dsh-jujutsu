# Changelog

Release-please writes the versioned sections below this line, newest first, from
the conventional commits on `main`. Everything above it is the hand-written
summary of the state before release-please took over — kept because the commits
it would have read were never written in conventional form, so there is nothing
for the bot to reconstruct.

## 0.1.0 — the first release

The plugin as it stands: a Jujutsu-native version-control surface for the
DeepSeek Harness.

**The guard.** A `tools/pre-execute` listener that refuses Git inside a jj
workspace and names the `jj` command to run instead — 43 message rows, each
naming the exact replacement. Fail-open and wrapped, so a detector bug cannot
cost every tool call. Reads and writes are configured separately. It refuses
writes into `.jj` and `.git`, and refuses commands whose text names either as a
path component, before anything runs.

**Eleven `jj` tools**, returning jj's own JSON rather than prose: status, log,
diff, op log, new, describe, squash, bookmark, op restore, and the two jj-hunk
bridges. Revisions are addressed by change ID, which survives a rewrite.

**Teaching.** The rule and the workspace state in the system prompt, withheld
where it would be false. A directory with no version control is reported rather
than passed over.

**A per-project switch.** `.dsh-jujutsu.json` disables the plugin for a subtree,
with the nearest marker winning. A malformed marker is treated as absent, so a
typo cannot silently disable the guard.

**A settings panel**, on the plugin's own page: `Switch` for each boolean,
`SegmentedControl` for each enum with localized segment labels, in English and
Chinese. Advanced settings — where the binaries are found — are config-file only.

**Verified rather than assumed.** Every harness contract read from the
`0.2.0-rc.2` source with line citations; every jj behaviour measured against the
installed 0.46.0. The guard was observed refusing real commands from inside a real
session, and the packed tarball is installed with plain npm and loaded on every
CI run.

See `docs/` for the verification records and `SPEC.md` for the build
specification.
