# Contributing

## Releasing

Three ways in, one publish path (`release.yml`), so the entries cannot drift:

| Trigger                       | What it needs                                | When to use it                                          |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| Manual, from the Actions page | the npm Trusted Publisher, and nothing else  | the default when you want a release now                 |
| Merging a release-please PR   | `RELEASE_PLEASE_TOKEN` for that PR to get CI | steady state, conventional commits doing the versioning |
| Pushing a `vX.Y.Z` tag        | nothing                                      | when the tag already exists                             |

**Reach for the manual path first.** Actions → _release_ → _Run workflow_ →
`dry-run: false`. It runs the full gate, creates the tag and the GitHub Release if
they are missing, and publishes whatever version `package.json` holds. It needs no
secret at all: the tag is made with that run's own `GITHUB_TOKEN`, which is safe
**because** the publish happens in the same run — the standing objection to a
`GITHUB_TOKEN` tag is that it triggers no workflow, and here nothing needs
triggering.

`dry-run: true` is the default, and it is worth using: it runs every step except
the publish, so a stale npm, a failing build or a broken tag check surfaces
without a version on the registry.

**Rehearse from a tag, not just a branch, and know the difference.** The
tag-vs-manifest check keys on `github.ref_type`, so:

- dispatched from a **branch**, it is skipped — there is no tag to compare, and
  the run says so in its own summary rather than claiming otherwise;
- dispatched from a **tag**, it runs, and that is the only way to exercise it
  without publishing. `dry-run: true` still stops short of the registry.

So `gh workflow run release.yml --ref <tag> -f dry-run=true` covers the tag check
and `--ref <branch>` does not. The check's failure path is worth rehearsing once
against a deliberately mismatched tag; it is the step that prevents an npm version
nobody can match to a commit.

### 1. Trusted Publisher entries on npm

**Required for every release, whichever path.** Publishing uses OIDC, so no npm
token is stored anywhere and provenance is automatic. On npmjs.com — package
`dsh-jujutsu` → Settings → Trusted publishing — add **two** GitHub Actions
entries:

| Field      | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| Repository | `viztor/dsh-jujutsu`                                                 |
| Workflow   | `release.yml` — the tag-push and manual paths                        |
| Workflow   | `release-please.yml` — the automated path, which calls `release.yml` |
| Action     | tick **Allow npm publish** (see below)                               |

**Why two.** npm's own documentation, on this exact shape: _"Some GitHub Actions
workflows use `workflow_call` to invoke other workflows that run `npm publish`…
When this happens, validation checks the **calling workflow's name** instead of
the workflow that actually contains the publish command."_ On the automated path
the caller is `release-please.yml`, so that is the filename npm validates —
registering `release.yml` alone leaves the automated path failing authentication
while the manual one works. A package may hold up to ten trusted publishers, so
this is a normal configuration rather than a workaround. If you only ever intend
to use the manual path, the `release.yml` entry is enough.

**Tick "Allow npm publish".** A configuration created after 2026-09-03 permits
`npm stage publish` only, and `release.yml` runs a direct `npm publish`. The
checkbox (or `--allow-publish` on the CLI) is what grants it. This is the kind of
setting that fails at publish time with an authentication error and no hint about
which box was missed.

**npm does not validate a configuration when you save it** — a wrong repository or
filename surfaces only on the first publish, as an auth error. And a new
configuration must complete its first successful publish **within two days** or it
expires and must be recreated, so add it when you are ready to release.

Without it the publish step fails with an authentication error naming the
workflow — which is the point of trusted publishing: there is no secret to leak,
expire, or accidentally commit.

#### The first version is the exception, and it needs a token

`npm trust` is explicit — _"The package you're configuring must already exist on
the npm registry"_ — and npmjs.com has no settings page for a name nobody has
published. `dsh-jujutsu` has never been published, so the bootstrap is one
token-based publish, once, before any of the above can be configured:

```bash
npm login                     # interactive; OIDC cannot bootstrap a new package
pnpm run build
npm publish --access public --ignore-scripts
```

Then add the two trusted publishers above. Every version after that goes through
the workflow with no secret in the repository at all. `npm trust` can create the
entries from the command line once the package exists:

```bash
npm trust github dsh-jujutsu --file release.yml --repo viztor/dsh-jujutsu --allow-publish
npm trust github dsh-jujutsu --file release-please.yml --repo viztor/dsh-jujutsu --allow-publish
```

#### If a publish fails with an auth error

Check the filename before anything else: it must be the **calling** workflow's
filename for that path (`release-please.yml` for the automated one), it must
include `.yml`, and `id-token: write` must be granted to the calling job and
declared by the publishing job — which is where the grant actually comes from for
a `uses:` job. `release.yml` and `release-please.yml` both carry it, with comments
pointing at this rule.

If the automated path still fails after the filenames are right, add
`id-token: write` to `release-please.yml`'s **workflow-level** `permissions:` block
as well. It is deliberately not there: the job-level grant is the documented
mechanism, and a workflow-level grant would also be inherited by the
`release-please` job, which runs a third-party action pinned to a mutable major
tag and has no use for OIDC — and that job's workflow is the filename npm
validates. No rehearsal can settle which form is required, because a dry run skips
the `npm publish` that mints the token, so the first real release is the test.

### 2. A `RELEASE_PLEASE_TOKEN` secret — optional

Release-please reads conventional commits and opens a version-bump pull request.
It runs on the built-in `GITHUB_TOKEN` when this secret is absent, **and the
release still publishes**: `release-please.yml` calls `release.yml` in the same run
that creates the tag.

What the secret buys is the pull request, not the release. A PR opened with
`GITHUB_TOKEN` does not trigger `ci`, so the version bump would be the one change
in the repository that is never tested; and whether the action can open the PR at
all depends on the repository's _"Allow GitHub Actions to create and approve pull
requests"_ setting. Create a fine-grained personal access token with **Contents**
and **Pull requests** read/write on this repository only, and add it as the
repository secret `RELEASE_PLEASE_TOKEN`.

Without it, use the manual path above.

**Why this is not just "a token to add".** The first version of this pipeline made
the PAT load-bearing: a tag created with `GITHUB_TOKEN` triggers no workflow, so
release-please tagged, `release.yml` never fired, and the release looked cut
without shipping. It had never run once — no tag, no GitHub Release, no version on
npm — while `ci` was green on every push, because none of that is visible from the
working tree. Publishing from the run that creates the tag removes the dependency
rather than documenting it, and `scripts/check.ts` now asserts the wiring instead
of trusting it.

## The gate

```bash
pnpm install
pnpm run ci
```

`ci` is the whole gate in one command: `vp check` for format, lint and typecheck —
with warnings failing it, so a new warning stops the run instead of accumulating —
then the build, then the suite, then the package checks.

There is deliberately no commit hook. Vite+ can install one (`vp hooks enable`,
`vp staged`) and a contributor will reach for it, but commits here are `jj commit`,
and `jj` does not run Git hooks: measured on 0.46.0 with a colocated repository,
an executable `.git/hooks/pre-commit` is left untouched. What runs the gate is CI,
plus `prepublishOnly` for a publish by hand.

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
