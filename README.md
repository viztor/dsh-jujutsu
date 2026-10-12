# Jujutsu for DeepSeek Harness

Makes the harness **jj-native**. Inside a [Jujutsu](https://jj-vcs.dev) workspace
the agent stops reaching for Git and uses `jj` instead — and it is _told_ why,
rather than just being blocked.

- **Refuses Git where it would mislead.** `git status` in a colocated repo
  reports a different state than `jj status`. The guard catches that and hands
  back the command to run instead.
- **Eleven `jj` tools**, so the model can read and write history without
  shelling out and parsing output.
- **Teaches the model** what `jj` is: no staging area, `@` is always a commit,
  change IDs survive rewrites.
- **A settings panel**, on the plugin's own page.

The plugin is invisible outside a Jujutsu workspace. In a plain Git repo it does
nothing at all.

## Install

Install from the harness **Plugins** page, or:

```bash
dsh plugin install dsh-jujutsu
```

Then open **Plugins → Jujutsu** to configure it. It works out of the box; the
defaults are chosen to be safe.

### Requirements

|           |                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jj`      | **Required.** 0.46.0 or newer. `brew install jj`                                                                                                                                   |
| `jj-hunk` | Optional. Adds hunk-level `split`/`squash`. Without it those two tools report unavailable rather than failing. `cargo install --git https://github.com/laulauland/jj-hunk jj-hunk` |
| Node      | 24 or newer                                                                                                                                                                        |

## What it does

### Refuses Git, and says what to run instead

| You run                  | What happens                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `git status`             | `Refused: git status describes a Git working tree that does not exist here. Run: jj status` |
| `git commit -m "…"`      | `Refused: git commit -m. Run: jj commit -m "<msg>".`                                        |
| `git rebase -i`          | Refused — it needs a terminal. Suggests `jj rebase`, `jj squash`, `jj absorb`.              |
| `rm -rf .git`            | Refused, and explains that `jj`'s commit objects live there                                 |
| `jj status`, `jj log`, … | Run normally                                                                                |
| `echo "git commit"`      | Runs — it never touched Git                                                                 |

Reads and writes are configured separately. A user who is happy to let the model
_look_ with Git has not thereby agreed to let it _write_.

### Eleven `jj` tools

| Tool                                 | What it does                                             |
| ------------------------------------ | -------------------------------------------------------- |
| `jj_status`                          | The working copy, including whether it is **conflicted** |
| `jj_log`, `jj_diff`, `jj_op_log`     | History, changes, and the operation log                  |
| `jj_new`, `jj_describe`, `jj_squash` | Start, describe and fold changes                         |
| `jj_bookmark`, `jj_op_restore`       | Name revisions; undo anything                            |
| `jj_hunk_list`, `jj_hunk_apply`      | Select and apply individual hunks                        |

All of them return **structured JSON**, never prose. Revisions are addressed by
**change ID**, which survives a rewrite — a commit ID does not.

### Teaches the model

The model is told, in its system prompt, that version control here is Jujutsu
and what that implies. The rule is withheld where it would be false: in a plain
Git repo, or in a directory with no repository at all.

In a directory with **no** version control, the plugin says so — so the agent
can offer to initialise one, suggesting `jj git init` (colocated, so Git tooling
still works).

## Configuration

Open **Plugins → Jujutsu**. Most settings are on that page:

| Setting                         | Default | What it changes                                                                    |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| Guard                           | on      | Off leaves the guard mounted but inert — useful to see what it _would_ have caught |
| Read-only Git                   | `ask`   | What to do with `git status`, `git log`, …                                         |
| Writing Git                     | `ask`   | What to do with `git commit`, `git push`, …                                        |
| Remember approvals              | on      | Stop re-asking about a verb you already approved, for this session                 |
| Mention missing version control | on      | Tell the model when a directory has no repository                                  |
| Prefer Jujutsu                  | on      | Suggest `jj git init` rather than `git init`                                       |
| Explain Jujutsu in the prompt   | on      | Off means the guard still refuses Git but the model is not told why                |
| Offer the jj manual             | on      | Ship the `jj` manual as an on-demand skill                                         |

### Advanced: where the binaries are found

Three settings are **not on the page**, because only an unusual install needs them
and showing them would ask everyone else to decide about them. Set them in the
profile's config instead — they are ordinary `Config` fields:

| Setting       | Default   | What it changes                                                 |
| ------------- | --------- | --------------------------------------------------------------- |
| `jjPath`      | `jj`      | Set when `jj` is not on `PATH`, or to pin a specific build      |
| `jjHunkPath`  | `jj-hunk` | Same, for `jj-hunk`                                             |
| `hunkInstall` | `ask`     | What to do when `jj-hunk` is missing: `ask`, `never`, or `auto` |

### Turning it off for one project

Drop a `.dsh-jujutsu.json` in the project root:

```json
{ "enabled": false }
```

The **nearest** marker walking up from the working directory wins, so you can
disable a monorepo and re-enable one vendored `jj` repo inside it with
`{"enabled": true}`.

The file is yours to place — add it to `.gitignore` if the switch should stay
local, or commit it to share the behaviour with your team. A malformed marker is
ignored rather than obeyed, so a typo cannot silently disable the guard.

## Troubleshooting

**"Refused" when I wanted Git.** That is the plugin working. Set _Read-only Git_
or _Writing Git_ to `allow`, or add a `.dsh-jujutsu.json` with
`{"enabled": false}` for that project.

**Nothing happens at all.** The plugin only acts inside a Jujutsu workspace —
a directory with a `.jj` directory, in it or any parent. Check with
`jj status`; if that says _"There is no jj repo in '.'"_, the plugin is correctly
inactive. `jj git init` creates one (colocated by default).

**The hunk tools say unavailable.** `jj-hunk` is not installed or not on `PATH`.
Set _jj-hunk executable_ to an absolute path, or install it.

**`jj new` or `jj commit` is refused.** The plugin refuses commit-creating
commands when `jj` has no identity configured, because `jj` would create a commit
with an empty author that **cannot be pushed**:

```bash
jj config set --user user.name "Your Name"
jj config set --user user.email "you@example.com"
```

Commands that _preserve_ an author — `jj describe`, `jj squash` — are not
affected.

## For developers

The rest of this file is about building and verifying the plugin itself.

### Build and test

```bash
pnpm run build     # tsc -> lib/   then   vp pack -> lib/client.js
pnpm run ci        # typecheck, format + lint, build, then the suite
```

**`lib/` is not optional and not committed.** The published entry is emitted
JavaScript, because Node **refuses to strip types for files under
`node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). That is why the
plugin works from a `link:` install and would not work from a tarball: a link
resolves to the working tree, where stripping is allowed.

Two artifacts, built two ways, because they are loaded two ways:

|                 |                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`  | the host half. `tsc -p tsconfig.build.json`, ESM, with `rewriteRelativeImportExtensions` so the `./foo.ts` specifiers the source uses become `./foo.js` |
| `lib/client.js` | the browser half. `vp pack` from `src/client/panel.ts`, CommonJS wrapped in `window.__ModuleLoader__.load`                                              |

The client half cannot be plain `tsc` output: the web client does not `import` a
bundle, it evaluates one as a script and hands the factory a `require`. That
wrapper is the bundler's `banner`/`footer` in `vite.config.ts`. The route serves
`${package}/client.js` and accepts only `/^client\..*\.js$/`, so
`scripts/name-client-bundle.ts` renames what `vp pack` emits as `client.cjs`.

```bash
pnpm publish       # prepublishOnly runs `ci`, which builds and tests
```

### Layout

|                      |                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------- |
| `src/`               | The host half — guard, tools, prompt, detection. See [`src/README.md`](src/README.md). |
| `src/client/`        | The panel, built to `lib/client.js` by `vp pack`. Harness primitives only.             |
| `locale/`            | Display name and one-liner, per language.                                              |
| `SPEC.md`            | The build specification.                                                               |
| `docs/`              | 36 documents: verified contracts, measurements, decisions.                             |
| `research/digest.md` | The durable record of the conversation that seeded the design.                         |

### What is verified, and how

Every claim about the harness was read from the `0.2.0-rc.2` source with line
citations ([docs/11](docs/11-verified-dsh-api-contract.md)); every claim about
`jj` was measured against the installed 0.46.0 ([docs/13](docs/13-empirical-verification.md)).
Both documents record what the sweeps did **not** find, and what remains open.

The guard, the eleven tools, the prompt injection and the panel have all been
observed working in a live session. **193 tests**, `pnpm run ci` green.

### Where this came from

The design conversation happened in a **Google AI Mode** thread, shared as a
public link, and was scraped through an anti-bot proxy. The transcript is **not
kept verbatim** — it carried a personal share link and a private conversation.
It was distilled into [`research/digest.md`](research/digest.md) and the raw
scrape deleted. The digest is safe to publish; the thread was not.

## License

MIT — see [LICENSE](LICENSE).
