/**
 * Wrap the compiled client half in the loader's factory format.
 *
 * The web client loads a client bundle as a **script** that registers a factory:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * `factory(require)` returns the module's exports, and `require` resolves the
 * bundle's dependencies from the harness's own client graph. `tsc` emits a
 * CommonJS *body* — `exports.apply = …`, `require("@deepseek-ai/…")` — which is
 * exactly the right shape once something supplies `module` and `exports`. That
 * something is this wrapper.
 *
 * Writing the bundle by hand instead was the earlier approach, and it is why the
 * panel shipped three type errors: nothing typechecked it. The wrapper is small
 * enough to be obviously correct, and it means `src/client/panel.ts` is a normal
 * TypeScript module that `tsc` checks like any other.
 *
 * Usage: node scripts/build-client.mjs   (after `tsc -p tsconfig.build.json`)
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "lib/client/panel.js";
const TARGET = "client/panel.js";
const ID = "dsh-jujutsu";

let body;
try {
  body = readFileSync(SOURCE, "utf8");
} catch {
  console.error(
    `build-client: ${SOURCE} is missing. Run \`tsc -p tsconfig.build.json\` first.`,
  );
  process.exit(1);
}

// The emitted body must not carry its own loader call; the wrapper owns that.
if (body.includes("__ModuleLoader__")) {
  console.error(
    `build-client: ${SOURCE} calls __ModuleLoader__ itself. The loader call belongs to this wrapper.`,
  );
  process.exit(1);
}

const wrapped = `/**
 * GENERATED FILE — do not edit.
 *
 * Built from \`src/client/panel.ts\` by \`scripts/build-client.mjs\`, which wraps
 * tsc's CommonJS output in the loader factory the web client expects. Edit the
 * TypeScript, not this.
 */
(function () {
  var factory = function (require) {
    var module = { exports: {} };
    var exports = module.exports;
${body
  .split("\n")
  .map((line) => (line.length === 0 ? line : `    ${line}`))
  .join("\n")}
    return module.exports;
  };
  window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: factory });
})();
`;

writeFileSync(TARGET, wrapped);
const lines = wrapped.split("\n").length;
console.log(`build-client: ${SOURCE} -> ${TARGET} (${lines} lines)`);
