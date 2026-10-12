/**
 * Render the panel with the REAL harness components.
 *
 * Every other check of this panel uses doubles: a stub `ConfigField`, a stub
 * `SettingsFormModel`. That proves the panel calls the right props, but not that
 * the real components accept them, and not what comes out.
 *
 * This script loads the actual `@deepseek-ai/dsh-client-ui-primitives` and
 * renders the panel to static HTML with `react-dom/server`. It resolves those
 * from a sibling plugin's install, because the harness ships them inside its own
 * tree rather than a project's.
 *
 * Usage: NODE_PATH=<dir with react/react-dom/@deepseek-ai> node render-panel.mjs
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Resolve from the CALLER's directory, not this file's. The harness ships the
// primitives inside its own tree without react/react-dom (those are browser-side
// and arrive with the shell bundle), so rendering needs a directory that has all
// of them together. Point the script at one with `cd`.
const require = createRequire(join(process.cwd(), "resolve-from-here.cjs"));

const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

console.log("primitives:", Object.keys(primitives).filter((k) =>
  ["ConfigField", "DisclosureRow", "SettingsForm", "SettingsFormModel",
   "settingsTextField"].includes(k)).join(", "));
console.log("react:", React.version);

// --- load the plugin's client bundle -------------------------------------
let factory;
globalThis.window = {
  __ModuleLoader__: { load: (m) => { factory = m.factory; } },
};
const source = readFileSync(new URL("../client/panel.js", import.meta.url), "utf8");
new Function("window", source)(globalThis.window);
if (factory === undefined) throw new Error("bundle did not register");

const plugin = factory((id) => {
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  if (id === "react") return React;
  throw new Error(`unexpected require: ${id}`);
});

// --- a real SettingsFormModel over a fake scope ---------------------------
// The scope shape is `{ getSnapshot, subscribe, mutate }`, which is what
// `ctx.configForms.get(NS)` returns.
const values = {
  enabled: true,
  guard: "deny",
  readOnlyGit: "ask",
  bypass: "ask",
  rememberBypass: true,
  alertUninitialised: true,
  preferJj: true,
  injectContext: true,
  teachSkill: true,
  jjPath: "jj",
  jjHunkPath: "jj-hunk",
  hunkInstall: "ask",
};
const scope = {
  getSnapshot: () => ({ values, overridden: {}, revision: 1 }),
  subscribe: () => () => {},
  mutate: async () => {},
};

const model = new primitives.SettingsFormModel(
  scope,
  plugin.buildSpecs(),
  [],
);

// --- render ---------------------------------------------------------------
const html = renderToStaticMarkup(
  React.createElement(plugin.Panel, { model, t: (key) => plugin.STRINGS.en[key] ?? key }),
);

console.log("\n--- rendered markup ---");
console.log(html.replace(/></g, ">\n<"));
console.log("\n--- length:", html.length, "chars ---");
