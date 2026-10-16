/**
 * Package checks — what a consumer receives, not what the working tree holds.
 *
 * Every test in `test/` runs against the source. This runs against the
 * **tarball**: it packs, installs with plain `npm` into a scratch directory, and
 * loads the result. That distinction is the whole point of the file, because the
 * constraint that shapes this package is invisible to every other check —
 *
 *   Node refuses to strip types for files under `node_modules`
 *   (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)
 *
 * — so a package whose entry is `src/index.ts` passes every test and cannot load
 * once installed. That was measured, not assumed, and it is why `lib/` exists.
 *
 * Usage: node scripts/check.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const failures: string[] = [];
const checks: string[] = [];

/**
 * npm's cache, moved inside the temp area for this run.
 *
 * npm writes to `~/.npm/_cacache` and `~/.npm/_logs` by default, and neither is
 * writable under the sandbox a coding agent runs in. The tarball check — the only
 * check here that sees what a consumer receives — therefore failed with
 * `EPERM … /Users/<name>/.npm/_cacache`, which names the symptom (a stale
 * root-owned cache) and not the cause (a check that depends on a writable home
 * directory). CI has a writable `$HOME`, so this was invisible there and fatal
 * locally, which is the wrong way round: the local run is where it is needed.
 *
 * Per-process, like the e2e root, so two concurrent runs cannot share a cache
 * directory they are both mutating.
 */
const NPM_CACHE = mkdtempSync(join(tmpdir(), "dsh-jujutsu-npm-cache-"));

/** Record one check's outcome. */
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    checks.push(name);
    return;
  }
  failures.push(detail === "" ? name : `${name}: ${detail}`);
}

/**
 * `npm publish` exports the whole `npm_config_*` namespace to its children,
 * including `npm_config_dry_run`. A child `npm install` that inherits it becomes
 * a no-op, and this script would then read a package that was never written —
 * failing with a message that names neither the cause nor the command. Stripping
 * the namespace rather than just `dry_run` is deliberate: a future npm setting
 * that changes what an install writes is the same failure wearing a new name.
 *
 * `cache` is then set explicitly, after the strip, for the reason above it.
 */
function npmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("npm_config_")) continue;
    env[key] = value;
  }
  env.npm_config_cache = NPM_CACHE;
  return env;
}

/** Run a command, returning its stdout, or throwing with its stderr. */
function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", env: npmEnv() });
}

// --- 1. The release wiring agrees -----------------------------------------
//
// A tag that disagrees with the manifest publishes a version nobody can match
// to a commit. The three files are written by different tools — package.json by
// release-please, the manifest by release-please, the config by hand — so they
// are checked together rather than trusted to stay in step.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
    repository: { url: string };
    homepage: string;
    bugs: { url: string };
  };
  const manifest = JSON.parse(
    readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
  ) as Record<string, string>;
  const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
    packages: Record<string, unknown>;
    "include-component-in-tag"?: boolean;
  };

  check(
    "the manifest version matches package.json",
    manifest["."] === pkg.version,
    `manifest has ${String(manifest["."])}, package.json has ${pkg.version}`,
  );

  // Three fields, one repository, written by hand three times. npm renders all
  // three on the package page, so a disagreement is visible to every reader.
  const slug = pkg.repository.url.replace(/^git\+|\.git$/g, "");
  check("homepage points at the repository", pkg.homepage.startsWith(slug), pkg.homepage);
  check("bugs points at the repository's issues", pkg.bugs.url.startsWith(slug), pkg.bugs.url);

  check(
    "release-please is configured for the package root",
    Object.keys(config.packages).includes("."),
    `packages: ${Object.keys(config.packages).join(", ")}`,
  );
  // The default prefixes the component (`dsh-jujutsu-v0.2.0`), which matches no
  // `v*.*.*` filter and so would never fire the publish workflow — a release
  // that looks cut and never ships.
  check(
    "tags are plain vX.Y.Z, so the publish workflow fires",
    config["include-component-in-tag"] === false,
  );
}

// --- 1b. The release path is wired, not merely written ---------------------
//
// Everything above checks that a release WOULD be named consistently. This block
// checks that anything ever runs at all, because for this repository nothing did:
// the publish steps existed, were correct, and had never executed once. No tag,
// no GitHub release, no version on npm — and `pnpm run ci` was green throughout,
// because none of it is visible from the working tree.
//
// The cause was structural. `release-please.yml` created the tag with a
// `GITHUB_TOKEN` (or, with no secret, did not run at all), and a tag made that way
// triggers no workflow — so `release.yml`, which fires on `v*.*.*`, was never
// reached. The fix is that the run which creates the tag also publishes it.
{
  const workflows = join(ROOT, ".github/workflows");
  const release = readFileSync(join(workflows, "release.yml"), "utf8");
  const please = readFileSync(join(workflows, "release-please.yml"), "utf8");

  check(
    "release.yml is callable, so a tag is published by the run that made it",
    /^ {2}workflow_call:/m.test(release),
  );
  check("release.yml still fires on a version tag", /tags:\s*\["v\*\.\*\.\*"\]/.test(release));
  check(
    "release-please publishes in the same run that creates the tag",
    /uses:\s*\.\/\.github\/workflows\/release\.yml/.test(please),
  );
  // Without the gate, every push to main would try to publish the version that is
  // already on the registry. The `npm view` guard would absorb it, which is why a
  // missing gate is easy to miss and worth pinning.
  check(
    "the publish job runs only when a release was actually created",
    /needs\.release-please\.outputs\.release_created\s*==\s*'true'/.test(please),
  );
  // A publish step wrapped in `|| true` or `continue-on-error` reports green for a
  // version that never reached the registry. That is not hypothetical here: the
  // comment above the publish step records that it happened once, which is why the
  // step is unguarded by design.
  check(
    "the publish step cannot be swallowed",
    !/continue-on-error/.test(release) && !/npm publish[^\n]*\|\|/.test(release),
  );

  // The tag-vs-manifest guard, pinned to the shape that is correct.
  //
  // This check exists because the guard was written the obvious way and the
  // obvious way is wrong: `if: inputs.expected-tag != ''` reads as "run when the
  // caller supplied a tag", but `inputs` is only populated for `workflow_dispatch`
  // and `workflow_call`. On a tag push it is the empty string, so the comparison
  // evaluates to false and the step is SKIPPED — a tag that disagrees with
  // `package.json` would build, find the version absent, publish it, and report
  // green. Nothing in a local run catches that: it needs a runner, and the
  // rehearsal that looked like it covered the step (a dry run dispatched from a
  // branch) skips it too, because a branch has no tag to compare.
  //
  // So the invariant is asserted instead: the guard must key on whether there is
  // a tag to compare — the ref type, or a tag supplied by the caller — and must
  // not be gated on `inputs` alone.
  const tagStep =
    /- name: The tag matches the manifest version\n([\s\S]*?)\n {6}- name:/.exec(release)?.[1] ??
    "";
  check(
    "the tag-vs-manifest guard runs whenever there is a tag to compare",
    tagStep !== "" &&
      /if:\s*github\.ref_type == 'tag' \|\| inputs\.expected-tag != ''/.test(tagStep),
    tagStep === "" ? "step not found" : "the guard does not name github.ref_type",
  );
  check(
    "the tag-vs-manifest guard falls back to the pushed tag",
    /EXPECTED_TAG:\s*\$\{\{\s*inputs\.expected-tag\s*\|\|\s*github\.ref_name\s*\}\}/.test(tagStep),
    "expected `inputs.expected-tag || github.ref_name`",
  );
  // A trusted publisher is registered on npm against a workflow FILENAME. Two
  // things make that harder to keep true than it looks: npm does not validate a
  // configuration when it is saved — a wrong name surfaces only as an auth error
  // on the first publish — and when `workflow_call` is involved npm validates the
  // CALLING workflow's name, not the file that runs `npm publish`. So the
  // automated path needs an entry for the caller as well.
  const named = [
    ...readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8").matchAll(
      /^\|\s*Workflow\s*\|\s*`([^`]+)`/gm,
    ),
  ].map((match) => match[1] ?? "");
  check(
    "CONTRIBUTING names at least one trusted-publisher workflow",
    named.length > 0,
    "no `| Workflow | `name` |` row found",
  );
  for (const file of named) {
    check(`the trusted-publisher workflow ${file} exists`, existsSync(join(workflows, file)));
  }
  check(
    "the workflow that runs npm publish is among the named ones",
    named.some(
      (file) =>
        existsSync(join(workflows, file)) &&
        readFileSync(join(workflows, file), "utf8").includes("npm publish"),
    ),
    named.join(", "),
  );
  // Derived rather than hard-coded, so renaming the caller cannot quietly skip
  // this: whatever calls the publishing workflow must have its own npm entry.
  const callers = readdirSync(workflows).filter(
    (file) =>
      /\.ya?ml$/.test(file) &&
      /uses:\s*\.\/\.github\/workflows\/release\.yml/.test(
        readFileSync(join(workflows, file), "utf8"),
      ),
  );
  check(
    "every workflow that calls the publisher has a trusted-publisher entry",
    callers.every((file) => named.includes(file)),
    `callers: ${callers.join(", ") || "none"}; named: ${named.join(", ")}`,
  );
}

// --- 1c. The gate is one command, and every workflow runs all of it ---------
//
// Twice now a subset of the gate has run and reported green, and neither time
// was any individual step wrong:
//
//   - `release.yml` ran `pnpm run ci` without `jj` or `jj-hunk` installed, so
//     every test that drives a real binary skipped — and a skip is not a
//     failure (`release.yml` sets `DSH_JUJUTSU_REQUIRE_TOOLS` for exactly this).
//   - `ci.yml` ran the package checks twice, because they are the tail of
//     `pnpm run ci` and also had a step of their own — the same command in two
//     places, which is the drift a single gate command exists to prevent.
//
// So the invariant is about composition rather than about any one step: a
// workflow that runs the gate runs the same gate, under the same conditions,
// once, and the stages are in the order that makes each of them meaningful.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const gate = pkg.scripts?.ci ?? "";
  // The panel tests read `lib/client.js`, the *built* artifact, so a suite that
  // ran before the build would test whatever was built last. The comment in
  // `ci.yml` records why the build is inside the gate at all.
  const build = gate.indexOf("pnpm run build");
  const test = gate.indexOf("vp test run");
  check("the gate builds before it tests", build !== -1 && test !== -1 && build < test, gate);
  // The tarball check is the only one that sees what a consumer receives. As the
  // tail of `ci` it covers a local run and a release alike; a gate without it
  // cannot notice the package that installs and does not load.
  check("the gate ends with the package checks", /&&\s*pnpm run check\s*$/.test(gate), gate);

  const workflows = join(ROOT, ".github/workflows");
  const runners = readdirSync(workflows)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => readFileSync(join(workflows, file), "utf8").includes("pnpm run ci"));
  // Without this, a renamed gate command would make every assertion below match
  // nothing, and a check that matches nothing passes for the wrong reason.
  check(
    "at least one workflow runs the gate",
    runners.length > 0,
    `no workflow runs \`pnpm run ci\``,
  );
  for (const file of runners) {
    const text = readFileSync(join(workflows, file), "utf8");
    check(
      `${file} sets up the tools the gate needs`,
      /uses:\s*\.\/\.github\/actions\/setup/.test(text),
      "a setup that is not shared is one that drifts",
    );
    check(
      `${file} demands that the real binaries ran`,
      /DSH_JUJUTSU_REQUIRE_TOOLS\s*:\s*["']?1["']?/.test(text),
      "a skip is not a failure",
    );
    check(
      `${file} does not run the package checks beside the gate`,
      !/\brun:\s*node scripts\/check\.ts/.test(text),
      "`scripts/check.ts` is the tail of `pnpm run ci`, not a step of its own",
    );
  }
}

// --- 2. The build output is current and complete --------------------------
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    main: string;
    types: string;
    files: string[];
    exports: Record<string, { default?: string } | string>;
  };
  const host = join(ROOT, pkg.main);
  check("the host entry exists", existsSync(host), pkg.main);
  check("the declarations exist", existsSync(join(ROOT, pkg.types)), pkg.types);

  // `files: ["lib"]` shipped everything in the directory, which was 93 files and
  // 377 kB for a plugin whose entry points are four of them. The sourcemaps were
  // most of the weight, and they resolve to `../src/*.ts` — source that is not in
  // the tarball, so they are useful in a `link:` install and dead in a published
  // one. The globs keep them on disk and out of the package.
  // The test is "names a file or a pattern", not "has an extension": `LICENSE`
  // is a file with no dot, and an extension check called it a bare directory.
  const bare = pkg.files.filter((entry) => {
    const full = join(ROOT, entry);
    return existsSync(full) && statSync(full).isDirectory();
  });
  check("the manifest lists no bare directory", bare.length === 0, bare.join(", "));

  const clientExport = pkg.exports["./client"];
  const clientPath = typeof clientExport === "string" ? clientExport : clientExport?.default;
  check(
    "the client export exists",
    typeof clientPath === "string" && existsSync(join(ROOT, clientPath)),
    String(clientPath),
  );

  // The route serves `${package}/client.js` and accepts only
  // `/^client\..*\.js$/`, while `vp pack` emits `.cjs` for a `type: module`
  // package. The rename is a build step, and this is what says it ran.
  check(
    "the client bundle is named client.js",
    typeof clientPath === "string" && clientPath.endsWith("/client.js"),
    String(clientPath),
  );

  const locale = readdirSync(join(ROOT, "locale")).filter((f) => f.endsWith(".json"));
  check("both locales ship", locale.length >= 2, locale.join(", "));
  check("the icon ships", existsSync(join(ROOT, "icon.svg")));
  check("the bundle patch ships", existsSync(join(ROOT, "cordis.patch.yml")));

  // The same sentence describes this plugin in two places, and only one of them
  // is in the repository the reader is looking at: `package.json` is what npm
  // shows, `locale/en.json` is what the Plugins page shows. They drifted once --
  // the package kept the old "Jujutsu-native version control" wording long after
  // the panel was corrected -- and nothing caught it, because each was checked
  // only for being non-empty.
  const english = JSON.parse(readFileSync(join(ROOT, "locale/en.json"), "utf8")) as {
    meta?: { description?: string };
  };
  const oneliner = english.meta?.description ?? "";
  const pkgDescription = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { description: string }
  ).description;
  check(
    "the npm description opens with the plugin's own one-liner",
    oneliner !== "" && pkgDescription.startsWith(oneliner),
    `npm: "${pkgDescription.slice(0, 60)}…" vs panel: "${oneliner.slice(0, 60)}…"`,
  );
}

// --- 3. A doc comment may not name an artifact that does not exist ---------
//
// Two files kept pointing at `client/panel.js` for several commits after the
// panel moved to TypeScript and became `lib/client.js` -- and one of them was
// `src/config.ts`, whose comment `tsc` copies verbatim into the shipped
// `lib/config.d.ts`. A reader of the published package was being sent to a file
// that had not existed for a week.
//
// Prose about paths is the cheapest thing to get wrong and the hardest to notice,
// so the two names that have actually changed are checked rather than trusted.
{
  const dead = ["client/panel.js", "lib/client.cjs"];
  const scanned: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|d\.ts|json|md|yml)$/.test(name)) continue;
      const text = readFileSync(full, "utf8");
      for (const name2 of dead) {
        if (text.includes(name2)) scanned.push(`${full.replace(ROOT, "")} names ${name2}`);
      }
    }
  };
  // `src` and `lib` only: the two files that legitimately name these are the
  // rename script and this check, and neither ships.
  for (const target of ["src", "lib"]) walk(join(ROOT, target));
  check("no shipped file names a renamed artifact", scanned.length === 0, scanned.join("; "));
}

// --- 4. No machine paths in anything that ships ---------------------------
//
// A home directory leaks a username, an OS and a layout, and it is worthless to
// the reader. Scanned over the shipped files rather than the tree, because those
// are the ones a stranger receives.
{
  const shipped = ["src", "lib", "locale", "client", "README.md", "SPEC.md"];
  const offenders: string[] = [];
  const walk = (target: string): void => {
    if (!existsSync(target)) return;
    if (statSync(target).isDirectory()) {
      for (const name of readdirSync(target)) {
        if (name === "node_modules") continue;
        walk(join(target, name));
      }
      return;
    }
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf|zip|gz|tgz)$/.test(target)) return;
    const text = readFileSync(target, "utf8");
    for (const pattern of [/\/Users\/[a-z]/i, /\/home\/[a-z]/i, /C:\\Users\\/i]) {
      if (pattern.test(text)) offenders.push(target.replace(ROOT, ""));
    }
  };
  for (const target of shipped) walk(join(ROOT, target));
  check("no machine paths in shipped files", offenders.length === 0, offenders.join(", "));
}

// --- 5. The tarball installs and loads with plain npm ---------------------
//
// The check that earns the file. Everything above inspects files; this one asks
// whether a consumer can use the package at all.
{
  const scratch = mkdtempSync(join(tmpdir(), "dsh-jujutsu-check-"));
  try {
    const packed = run("npm", ["pack", "--pack-destination", scratch], ROOT)
      .trim()
      .split("\n")
      .pop();
    const tarball = join(scratch, packed ?? "");
    check("npm pack produced a tarball", packed !== undefined && existsSync(tarball), packed ?? "");

    if (existsSync(tarball)) {
      // What is actually inside, rather than what `files` says should be. The
      // distinction matters: `files: ["lib"]` shipped everything in the
      // directory — 93 files and 377 kB — and the sourcemaps were most of it.
      // They resolve to `../src/*.ts`, source that is not in the tarball, so they
      // help in a `link:` install and are dead weight in a published one.
      const contents = run("tar", ["-tzf", tarball], ROOT)
        .split("\n")
        .map((line) => line.replace(/^package\//, ""))
        .filter((line) => line !== "");
      const maps = contents.filter((name) => name.endsWith(".map"));
      check(
        "no sourcemaps in the published package",
        maps.length === 0,
        maps.slice(0, 3).join(", "),
      );
      check(
        "the package carries its entry points",
        contents.includes("lib/index.js") &&
          contents.includes("lib/index.d.ts") &&
          contents.includes("lib/client.js") &&
          contents.includes("cordis.patch.yml"),
        `${contents.length} files`,
      );

      run("npm", ["init", "-y"], scratch);
      run("npm", ["install", "--no-audit", "--no-fund", tarball], scratch);

      const installed = join(scratch, "node_modules", "dsh-jujutsu");
      check("the package installs into node_modules", existsSync(installed));

      // `require` rather than `import`: this is the CommonJS face the harness's
      // loader uses, and it is the one that fails on un-stripped TypeScript.
      const probe = `
        const mod = require('dsh-jujutsu');
        const names = Object.keys(mod).sort().join(',');
        if (!names.includes('apply')) throw new Error('no apply export: ' + names);
        if (!names.includes('inject')) throw new Error('no inject export: ' + names);
        if (!names.includes('Config')) throw new Error('no Config export: ' + names);
        process.stdout.write(names);
      `;
      const loaded = run("node", ["-e", probe], scratch);
      check(
        "the installed package loads and exports what Cordis reads",
        loaded.includes("apply"),
        loaded,
      );

      // The client half is a script, not a module: it registers a factory and
      // the loader calls it. Loading it needs a `window` stub and nothing else.
      const clientProbe = `
        let factory;
        global.window = { __ModuleLoader__: { load: (m) => { factory = m.factory; } } };
        require('dsh-jujutsu/client');
        if (typeof factory !== 'function') throw new Error('no factory registered');
        process.stdout.write('ok');
      `;
      const client = run("node", ["-e", clientProbe], scratch);
      check("the installed client bundle registers its factory", client.includes("ok"), client);
    }
  } catch (error) {
    check(
      "the tarball installs and loads",
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- report ----------------------------------------------------------------
rmSync(NPM_CACHE, { recursive: true, force: true });
for (const name of checks) console.log(`ok    ${name}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
console.log(`\n${checks.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
