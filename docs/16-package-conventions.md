# 16 — Package conventions for a DSH host plugin

**Status:** read out of `dsh-tinyfish` (a shipping DSH plugin) and the
`cordis-plugin-development` skill. These are conventions to copy, not
inventions.

## The manifest

A package's `dsh` field is read by two independent subsystems:

| key           | reader               | effect                                    |
| ------------- | -------------------- | ----------------------------------------- |
| `dsh.bundle`  | `dsh-app-boot`       | the package's patch joins the composition |
| `dsh.client`  | `dsh-client-modules` | the web client loads `lib/client.js`      |
| `dsh.profile` | `dsh-app-boot`       | only meaningful in a profile manifest     |

`dsh-jujutsu` needs **both `dsh.bundle` and `dsh.client`**. This line used to say
the plugin needed only `dsh.bundle`, on the grounds that it shipped no browser
half at all. That stopped being true when the settings panel landed — the panel
is now the largest surface the plugin has, and a document about package
conventions is exactly where a reader checks whether they need `dsh.client`, so
being wrong here costs more than being silent.

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-plugin-manager"
    ],
    "platform": "web",
    "immediately": true
  }
}
```

The two halves are loaded by different machinery and never consult each other:
`dsh-app-boot` reads `dsh.bundle`, `dsh-client-modules` reads `dsh.client`. One
package carrying both is why the user installs once.

## Bundle patch rules

Four rules, each of which has already bitten a real plugin:

1. **The row `name` must equal the installed package name.** The loader resolves
   a bundle entry and every patch row's `name` to a path under the profile's
   `node_modules`. `dsh-opencode-patch` shipped with its row naming the
   unscoped `dsh-opencode` while the package was scoped, and the entry answered
   "failed to import" until they matched. The **exported** `name` is the
   plugin's own identity and need not match the manifest.

2. **A patch `name` is an assertion, not a label.** For a non-insert patch the
   target is matched by `id` alone. If `name` is present it must equal the
   target's existing plugin name, or the merge warns and **skips**. Writing an
   official package's name in order to override its config is read as
   impersonation. Override by `id` and omit `name`.

3. **`config` is replaced wholesale, not deep-merged.** An override must
   restate every field it means to keep.

4. **Later layers win.** Patch lists apply in `dsh.profile.bundles` order over
   an empty entry list, then the profile's own patches, then any launch patch.
   That is what lets a host override a bundle's default.

Minimal patch for this plugin:

```yaml
- insert:
    - id: dsh-jujutsu
      name: "dsh-jujutsu"
      config:
        guard: deny
```

No overrides of other rows: unlike `dsh-tinyfish` (which repoints the `web`
seam), `dsh-jujutsu` adds a policy listener and changes no existing service.

## The plugin entry

```ts
export const name = 'dsh-jujutsu';
export const inject = ['tools', 'fs'];   // + whatever detection needs
export const Config = z.object({ … });   // from @deepseek-ai/schemastery
export function apply(ctx: Context) { … }
```

- **`inject`** declares the services the plugin needs; Cordis resolves them
  before `apply` runs. Shipping plugins do this — `dsh-tool-bash` injects
  `["tools", "shell", "systemPrompt", "shellEnv"]`.
- **`Config`** comes from `@deepseek-ai/schemastery`, the harness's fork, not
  the public `schemastery` — the fork implements the `.role()`, `.volatile()`
  and `.get()` surface the loader and settings UI rely on. Exporting a `Config`
  is what makes the row render as a real settings section instead of free-form
  YAML. Cordis falls back to the raw row when a plugin exports none.
- A plugin with no `Config` still loads, but its row is unvalidated. Export one.

## Installation

Author the bundle as ordinary workspace files, then install it into the profile
with `plugin_manager`, `action: install_bundle`, `target: <absolute package dir>`.

**Do not** hand-write the profile's `package.json` or `cordis.patch.yml`, create
packages under `$DSH_HOME`, or run pnpm in the profile directory — `install_bundle`
performs those steps, and each hand-made write outside the workspace needs its
own approval. Read the result's `application` and `warnings` fields to decide
whether the change is live; a live profile with HMR reports `applied` without a
restart, and only a host without HMR reports `restart-required`.

## Build

`dsh-tinyfish` uses `vite-plus` (`vp pack`, `vp check`, `vp test`) with
`ultracite` for lint/format and `tsc --noEmit` for types. `dsh-jujutsu` should
copy that toolchain so the two repos stay legible to the same reader.

## What to leave out

**Superseded.** This section used to say there is no client half, and listed
`dsh.client`, `locale/*.json`, `react` and the client primitives as things this
package does not need. That is no longer true: the plugin ships an admin panel,
so it declares `dsh.client` and contributes to `plugins.bundle.config`
([29](29-state-config-and-sandbox-surfaces.md) §4).

What is absent, and why:

- **No `vite.live.config.ts`.** There is no live suite to configure. Every claim
  about `jj` in these documents was measured by hand against the installed
  binary, and the end-to-end tests drive real `jj` and `jj-hunk` through the
  plugin's own shell contract — so the network and a credential are never
  involved.
- **No `ultracite`.** `vp check` runs the formatter and linter as part of `ci`,
  which is the gate that matters. The larger rule set is a separate decision from
  having a gate at all, and it is not taken yet.

Two things this file used to list as deliberately absent, both since adopted —
recorded rather than deleted, because each was argued for at the time and the
argument turned out to be wrong:

- **"No bundler."** The client half was hand-written JavaScript in the CJS factory
  format, on the reasoning that the web client loads a bundle as a script and so
  it "must already be JavaScript". That was half true and used to skip the work:
  `vp pack` emits JavaScript, and `dsh-tinyfish` authors `src/client.ts` and
  builds `lib/client.js` the same way. The cost was every bug the panel had — all
  three were type errors `tsc` would have refused, because nothing checked a file
  written by hand. The client half is now `src/client/panel.ts`, built by
  `vp pack` with the loader wrapper as the bundler's `banner`/`footer`.
- **"No `locale/*.json`."** They exist now, for two languages, and they carry the
  plugin's display name and one-liner — the copy the host reads through
  `readPluginMeta` _before_ any bundle loads, which is why it cannot live in the
  bundle.

## A reinstall reloads the patch, not the code

**Measured, and it costs an afternoon if you do not know it.** Iterating on a
plugin that is already mounted does not pick up source changes:

| Action                                            | Result                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `install_bundle` again, same source               | `application: applied` — the **patch** re-applies, the **module** stays cached and the old code keeps running |
| Point `main` at a new file, reinstall             | still `applied`; the new file is never imported                                                               |
| `install_bundle` from a **different source path** | `application: restart-required`, with `Replaced "…" ("link:…") with "…" from a different source`              |

How that was established, rather than guessed: a diagnostic wrapper that appended
to `/tmp` on import produced an **empty log** across two reinstall cycles while
the already-loaded guard kept working, and a copy of the package at a second path
returned `restart-required`.

**Consequence.** Verifying a code change to an already-mounted plugin requires a
**harness restart**. There is no in-session workaround — changing the entry path,
removing and reinstalling, and replacing the package source were all tried.

**What to do instead.** Put everything you can behind tests that do not need the
harness (`test/` here runs the plugin against a harness double and real fixture
repos), and treat the live install as a check of _first_ mount and of _patch_
changes only. When a live check does matter, plan for a restart rather than
discovering the need mid-investigation.

This is also why `docs/35-probe-results-live.md` could verify the guard's
behaviour but not the eleven tools' registration: the guard was live in the
first-loaded module, and the tools were added afterwards.
