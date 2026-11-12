# Changelog

Release-please writes the versioned sections below this line, newest first, from
the conventional commits on `main`. Everything above it is the hand-written
summary of the state before release-please took over — kept because the commits
it would have read were never written in conventional form, so there is nothing
for the bot to reconstruct.

## [0.3.7](https://github.com/viztor/dsh-jujutsu/compare/v0.3.6...v0.3.7) (2026-11-12)


### Bug Fixes

* **status:** read the workspace name from jj 0.47's annotated listing ([77722ce](https://github.com/viztor/dsh-jujutsu/commit/77722ce872e3bb49c58e9a3534cb2eccc74e064c))

## [0.3.6](https://github.com/viztor/dsh-jujutsu/compare/v0.3.5...v0.3.6) (2026-11-12)

### Bug Fixes

- **deps:** keep the 4.0.6 tuple so alpha prereleases stay admitted ([f08ff35](https://github.com/viztor/dsh-jujutsu/commit/f08ff358bdfc360d7c78deb159b715d7a8659ada))

## [0.3.5](https://github.com/viztor/dsh-jujutsu/compare/v0.3.4...v0.3.5) (2026-11-12)

### Bug Fixes

- **deps:** declare support for the Cordis 4.1 line and the rc channel ([6061990](https://github.com/viztor/dsh-jujutsu/commit/6061990840e9b2ff405d8e33af0812d91d3ef92d))

## [0.3.4](https://github.com/viztor/dsh-jujutsu/compare/v0.3.3...v0.3.4) (2026-11-05)

### Bug Fixes

- **changelog:** drop the blank line the 0.3.3 section arrived with ([477cf2f](https://github.com/viztor/dsh-jujutsu/commit/477cf2fc62db9a956d5647dc125d8251adf8da98))

## [0.3.3](https://github.com/viztor/dsh-jujutsu/compare/v0.3.2...v0.3.3) (2026-11-05)

### Bug Fixes

- **release:** write the GitHub Packages token to the npmrc npm reads ([737cfd9](https://github.com/viztor/dsh-jujutsu/commit/737cfd9dc445b5ef587ff4061859af20821061b5))

## [0.3.2](https://github.com/viztor/dsh-jujutsu/compare/v0.3.1...v0.3.2) (2026-11-05)

### Bug Fixes

- **changelog:** format the 0.3.1 release bullets ([78f0fd8](https://github.com/viztor/dsh-jujutsu/commit/78f0fd801cc821991229f71afd1b9fb706a8aa64))

## [0.3.1](https://github.com/viztor/dsh-jujutsu/compare/v0.3.0...v0.3.1) (2026-11-05)

### Bug Fixes

- **changelog:** format the 0.3.0 release bullets ([0fe9efb](https://github.com/viztor/dsh-jujutsu/commit/0fe9efb0644ac27038f15d001657196e38ff3b7d))

## [0.3.0](https://github.com/viztor/dsh-jujutsu/compare/v0.2.0...v0.3.0) (2026-11-05)

### Features

- adopt a plain Git repo for Jujutsu, and refuse the ones jj cannot hold ([ce41b23](https://github.com/viztor/dsh-jujutsu/commit/ce41b2390c1e3fc5af51ed16bf4fe54e89d78f42))
- **agent:** add multi-agent coordination and the full jj tool surface ([cf38410](https://github.com/viztor/dsh-jujutsu/commit/cf384103d92fa212f8bab467edd35ad68089e3b5))
- force Jujutsu on request, teach it from a skill, and stop refusing submodules ([0699b58](https://github.com/viztor/dsh-jujutsu/commit/0699b5849f069438c817e5b4717a783eb28d5845))

### Bug Fixes

- a quoted heredoc body is data, not a Git invocation ([ba928e9](https://github.com/viztor/dsh-jujutsu/commit/ba928e9b92a7b5528f412c183c4cb41df9778c76))
- **package:** describe the tiered tool surface ([3c54951](https://github.com/viztor/dsh-jujutsu/commit/3c54951379ac16472fd2b8435113c2b8001a7414))
- **package:** keep peer ranges inside the tested DSH alpha line ([867c147](https://github.com/viztor/dsh-jujutsu/commit/867c1470288035859db6b1ab8ea4c0427b9a6355))
- the adoption probe accepted repositories jj would corrupt ([1b2bbb7](https://github.com/viztor/dsh-jujutsu/commit/1b2bbb7aa21edaf376f341830489c03d897491e2))
- the adoption tests commit without a Git identity, so CI could not run them ([fcec783](https://github.com/viztor/dsh-jujutsu/commit/fcec78381d0de40a627867013723c0351947a659))

## [0.2.0](https://github.com/viztor/dsh-jujutsu/compare/v0.1.0...v0.2.0) (2026-10-18)

### Features

- add the release pipeline, and drop the master switch the harness owns ([b724d19](https://github.com/viztor/dsh-jujutsu/commit/b724d19eb3a3e506defb6c79acab2919f4a7a479))
- carry a durable code on every guard denial ([d8ff100](https://github.com/viztor/dsh-jujutsu/commit/d8ff100c58319089adf81f5011aad3bef3396a33))
- implement hunkInstall, which was declared, documented, and read nowhere ([4182d6f](https://github.com/viztor/dsh-jujutsu/commit/4182d6f24079f943de3f59c18ea5709a97dd3438))
- publish from the run that creates the tag, and ship the jj skill it promised ([6110c15](https://github.com/viztor/dsh-jujutsu/commit/6110c157efdb1c444314d5a0b08ec0f545dc6e3f))
- the vocabulary is no longer a promise — every declared code is emitted ([b76ef5d](https://github.com/viztor/dsh-jujutsu/commit/b76ef5dcc622f774b60b076f0ca9b8a7b627aeb7))

### Bug Fixes

- answer how read-only Git is decided, and order both settings alike ([09c7ae6](https://github.com/viztor/dsh-jujutsu/commit/09c7ae67ad9fc0475ab82a72b69cba4fa0bc67e8))
- CI has been red on every push, because the suite never built its own fixtures ([bec5d6a](https://github.com/viztor/dsh-jujutsu/commit/bec5d6a37fb80bfbfacf125bacea6dce669f41f2))
- correct the npm description, and check it against the panel's one-liner ([c38a186](https://github.com/viztor/dsh-jujutsu/commit/c38a1869286e2f877e0d98f7f1ebb8eb129b4c1f))
- docs/16 denied a surface the manifest declares ([2eea58a](https://github.com/viztor/dsh-jujutsu/commit/2eea58a5845b3f149ab0b7b43a9236af0b191048))
- extract the jj tarball into a subdirectory, not /tmp itself ([e401fa1](https://github.com/viztor/dsh-jujutsu/commit/e401fa18e0be6091bffa61cd218cbbc7bc9bd6bf))
- four error codes that were declared and unreachable ([f3224bb](https://github.com/viztor/dsh-jujutsu/commit/f3224bb644e8d5e3f5c33b0d933d119389292675))
- install jj-hunk from git, not from crates.io — the crate is two versions behind ([14a6db8](https://github.com/viztor/dsh-jujutsu/commit/14a6db80401369d3dc224966b1b5c4568f7603fe))
- install jj-hunk in CI, and guard the hunk tests on it ([2fec8d5](https://github.com/viztor/dsh-jujutsu/commit/2fec8d5f071a5ca68a0b8b5f7443c88c93c2bcf1))
- make every toggle answer the one question a toggle asks ([7d67c78](https://github.com/viztor/dsh-jujutsu/commit/7d67c78a18922e421dc817dcd04d19271746a7a9))
- make Guard a switch, because it has two states and not three ([1df0cd0](https://github.com/viztor/dsh-jujutsu/commit/1df0cd0f10d82db7bfc9ea6a956145e3ec37a7bb))
- make the publish job testable, and stop betting on a contested OIDC behaviour ([94dd832](https://github.com/viztor/dsh-jujutsu/commit/94dd8325fb129762fcadf38fb2a8ea1f12c0509b))
- name a wrong jj-hunk as a wrong jj-hunk, not as a runtime failure ([84d4691](https://github.com/viztor/dsh-jujutsu/commit/84d4691324f6cf52f2e19e13ea35a9538d73044a))
- release.yml would have passed a release that tested nothing ([6e24edc](https://github.com/viztor/dsh-jujutsu/commit/6e24edc11ec0a1997026651297ac999734de59c1))
- say each fact once in the model-facing text, and correct the Guard row ([798023a](https://github.com/viztor/dsh-jujutsu/commit/798023a6f3986ed96cad19689753acc558fc13ea))
- stop a hint naming a config key instead of the setting ([c9fece1](https://github.com/viztor/dsh-jujutsu/commit/c9fece108dc92fb219058347f6f0162f26c96b5d))
- stop handing the model a jj command that jj would reject ([1ef171b](https://github.com/viztor/dsh-jujutsu/commit/1ef171bb6a57e18ca5edf98403fd46fec22621e8))
- stop release-please being red on every push, and say why instead ([f4ecfd3](https://github.com/viztor/dsh-jujutsu/commit/f4ecfd3ba6d76751f561a0efead321b46925726e))
- stop the docs naming artifacts that no longer exist ([6cc1450](https://github.com/viztor/dsh-jujutsu/commit/6cc1450e2baff57f4201cce89eb14b269d9b09d0))
- three more codes implemented, three removed as decisions not to act ([4c857a8](https://github.com/viztor/dsh-jujutsu/commit/4c857a8a917bde1e42bb595527d05c17be732e3d))

### Performance Improvements

- stop shipping sourcemaps that point at source the package does not contain ([a47dc30](https://github.com/viztor/dsh-jujutsu/commit/a47dc3028ca17e35432b33993a70468fa945ec6a))

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
