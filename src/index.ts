/**
 * `dsh-jujutsu` — refuses Git inside a Jujutsu workspace and hands the model the
 * jj command instead.
 *
 * A **policy plugin**, not a capability plugin: it owns no service, registers no
 * new capability, and exists only to constrain and inform the ones that do. The
 * shape is copied from `dsh-fs-observation-policy` — listeners on existing
 * waterfalls, plugin-local state, decisions the provider enforces. See
 * `SPEC.md` §3 and `docs/27-integration-surfaces.md`.
 *
 * Two halves, independently shippable:
 *
 *   1. **The guard** — `tools/pre-execute` refuses Git inside a `jj` workspace
 *      and names the exact `jj` command instead. This is the part that stops
 *      active harm, and it is what v0.1 is.
 *   2. **The tools and the `jj-hunk` bridge** — the eleven first-class tools in
 *      `docs/18-tool-surface.md`.
 *
 * @module dsh-jujutsu
 */

import type { Context } from "@deepseek-ai/cordis";

import { Config } from "./config.ts";
import { applyContext } from "./context.ts";
import { applyExplain } from "./explain.ts";
import { applyGuard } from "./guard.ts";
import { applyPreflight } from "./preflight.ts";
import { invalidateDetection } from "./detect.ts";
import { invalidateMarkers } from "./marker.ts";
import { resolveSettings } from "./settings.ts";
import { applySkill } from "./skill.ts";
import { applyTools } from "./tools.ts";

export { Config };

/**
 * The plugin's own identity. Note this need **not** match the package name — the
 * bundle row's `name` is what must match the installed package
 * (`docs/16-package-conventions.md`).
 */
export const name = "dsh-jujutsu";

/**
 * `tools` is required: the guard is a listener on its waterfall.
 *
 * Everything else is optional and resolved with `ctx.get(...)` or a nested
 * `ctx.inject(...)`, so a profile without `fs` or `systemPrompt` degrades rather
 * than failing to mount. `docs/29` §3 records that a host plugin in this profile
 * can in fact reach `systemPrompt`, `fs`, `approval`, `skills`, `commands` and
 * `userQuestions` — all six were confirmed present by the live probe
 * (`docs/35-probe-results-live.md`).
 */
export const inject = ["tools"];

/**
 * Mount the plugin.
 *
 * `config` is `unknown` by convention (the same signature `dsh-tinyfish` uses)
 * and narrowed rather than asserted, because a raw patch row that skipped schema
 * validation still reaches this function.
 */
export function apply(ctx: Context, config?: unknown): void {
  const settings = resolveSettings(config);

  // A mount is a boundary: module-level caches outlive an unmount, because the
  // harness keeps the module in its registry even after the bundle is removed.
  // Without this, a workspace created while the plugin was unmounted stays
  // invisible for the rest of the process — observed live, see src/README.md.
  invalidateDetection();
  invalidateMarkers();

  // The guard is the load-bearing half, so it is registered first: if a later
  // registration throws, the protection is already in place.
  applyGuard(ctx, settings);

  // The denial's second channel. Registered right after the guard because it
  // only ever acts on a call the guard refused.
  applyExplain(ctx, settings);

  if (settings.injectContext) applyContext(ctx, settings);

  // The manual, as a catalog line instead of a prompt section. Registered
  // unconditionally and gated inside, because `teachSkill` is a user-reversible
  // decision: off must mean the session's catalog never gains the entry
  // (docs/28 §1.5). It degrades silently where `ctx.skills` is not mounted.
  applySkill(ctx, settings);

  // Preflight is cheap and self-gating on `.jj`, and its own body is wrapped —
  // a throw in `agent/created` fails session creation, not one tool call.
  applyPreflight(ctx, settings);

  // The tool surface and the hunk bridge are additive.
  applyTools(ctx, settings);
}
