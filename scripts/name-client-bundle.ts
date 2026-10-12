/**
 * Name the browser bundle `client.js`.
 *
 * The harness's plugin route is fixed: `dsh-client-modules` serves
 * `${package}/client.js` and accepts only chunk names matching
 * `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`. So the artifact has to end in
 * `.js`.
 *
 * `vp pack` with `format: ["cjs"]` emits `.cjs` when the package is
 * `type: module` — which this is. That is not a contradiction: the file is
 * CommonJS wrapped in `window.__ModuleLoader__.load`, evaluated by the browser
 * rather than imported by Node, so the package `type` never applies to it. Only
 * the extension the route looks for matters.
 *
 * `outExtensions` would express this in the bundler, but it is not plumbed
 * through Vite+'s `pack` options, so the rename happens here. The sibling
 * package does the same, for the same reason.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(ROOT, "lib/client.cjs");
const served = join(ROOT, "lib/client.js");

if (!existsSync(built)) {
  // Nothing to do when the client half was not built.
  console.log("name-client-bundle: lib/client.cjs is absent; nothing to rename");
  process.exit(0);
}

// Removed rather than renamed aside: a `.stale` sibling would ride in every
// published tarball, because npm-packlist ships dotfiles inside a listed dir.
if (existsSync(served)) rmSync(served, { force: true });
renameSync(built, served);
console.log("name-client-bundle: lib/client.cjs -> lib/client.js");
