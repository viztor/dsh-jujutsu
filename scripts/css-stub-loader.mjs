/**
 * Registers the CSS-stubbing loader hooks.
 *
 * Usage:
 *   node --import /path/to/scripts/css-stub-loader.mjs /path/to/scripts/render-panel.mjs
 *
 * Separate from `css-stub-hooks.mjs` because a module cannot both call
 * `register` and export the hooks it registers.
 */

import { register } from "node:module";

register("./css-stub-hooks.mjs", import.meta.url);
