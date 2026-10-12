# Contributing

## One-time setup for releases

Release-please reads conventional commits and opens a version-bump pull request.
Merging that PR tags the release, and the tag publishes it. Two things have to be
in place once, by a repository admin, before any of that works.

### 1. A `RELEASE_PLEASE_TOKEN` secret

**Not optional.** Tags and releases created with the built-in `GITHUB_TOKEN` do
not trigger downstream workflows — so a release-please running on the default
token produces a tag that never publishes. The release looks cut and is not.

Create a fine-grained personal access token with **Contents** and **Pull
requests** read/write on this repository only, and add it as the repository
secret `RELEASE_PLEASE_TOKEN`.

Until it exists, the `release-please` workflow **skips** and emits a warning
naming the secret. It used to fail on every push with _"Input required and not
supplied: token"_ — the action's own message, and clear enough — but a workflow
that is red on every push stops meaning anything. That one trained its own author
to ignore a red CI for a week while `ci` was failing underneath it, so the red is
gone and the warning replaces it.

Getting there needed a fact worth recording: `secrets` cannot appear in an `if`.
Not at the job level and not at the step level — the
[contexts reference](https://docs.github.com/actions/reference/workflows-and-actions/contexts)
lists what each workflow key may read, and neither `jobs.<job_id>.if` nor
`jobs.<job_id>.steps.if` includes it. Referencing it makes GitHub reject the whole
file as invalid. `env` _is_ available to `if`, so the token is read into a
job-level `env` first and the steps test that.

### 2. A Trusted Publisher entry on npm

Publishing uses OIDC, so no npm token is stored anywhere and provenance is
automatic. On npmjs.com, add a Trusted Publisher to the `dsh-jujutsu` package:

| Field      | Value                |
| ---------- | -------------------- |
| Repository | `viztor/dsh-jujutsu` |
| Workflow   | `release.yml`        |
| Action     | `npm publish`        |

Without it the publish step fails with an authentication error naming the
workflow — which is the point of trusted publishing: there is no secret to leak,
expire, or accidentally commit.

## The gate

```bash
pnpm install
pnpm run ci
```

`ci` is the whole gate in one command: typecheck, then `vp check` for format and
lint, then the build, then the suite, then the package checks.

**But a green local run is not a green pull request.** That claim was here, and it
was wrong for a week: CI installs `jj` and `jj-hunk`, and a laptop often does not,
so the tests that drive a real repository skip locally and fail — or skip and hide
a failure — in CI. The workflows set `DSH_JUJUTSU_REQUIRE_TOOLS=1`, which turns
that skip into an error, so a green CI means the binaries were exercised. Locally
it stays a skip, with a line saying what was not checked.

Install both before trusting a local run:

```bash
cargo install --git https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk
```

**And check the run, not the command.** `gh run list` answers the question a local
run cannot:

```bash
gh run list --limit 5
```

Four separate defects in the release pipeline were invisible to `pnpm run ci` and
visible immediately in that output — including one where the fixtures were never
built and nine guard tests had been failing on every push.

**Build before you test.** The panel tests read `lib/client.js` — the _built_
artifact, because the source and the bundle are different things and the bundle
is what the browser loads. Running the suite without building first tests
whatever was built last.

## Commit messages

Release-please derives the version bump from the subject line, so the prefix
matters:

| Prefix                         | Effect                   |
| ------------------------------ | ------------------------ |
| `fix:`                         | patch                    |
| `feat:`                        | minor                    |
| `feat!:` or `BREAKING CHANGE:` | minor, while below 1.0.0 |
| anything else                  | no release               |

A breaking change stays on the minor line because `bump-minor-pre-major` is set.
Without it a `feat!` proposes 1.0.0, and this plugin has no business reaching
1.0.0 before the harness it plugs into leaves 0.x.

## Adding a setting

A setting can be **drawn on the panel** or **config-file only**, and the
difference is a decision rather than an oversight:

- Drawn: the reader will want to change it while looking at the page.
- Config-file only: only an unusual install needs it, and drawing it would ask
  every other reader to decide about it. The three executable-path settings are
  in this group.

Either way the field goes in `src/config.ts`. A drawn one also needs an entry in
`FIELDS` and a group in `GROUPS` in `src/client/panel.ts`, plus copy in both
locales. Tests will tell you what you missed: the panel must draw every field it
exposes, the config-file-only fields must still be declared, and every string key
must resolve in both languages.
