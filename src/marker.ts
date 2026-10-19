/**
 * The per-project switch: `.dsh-jujutsu.json`.
 *
 * ## Why this exists at all
 *
 * There is **no built-in mechanism** for either half of the question, and that
 * was checked rather than assumed:
 *
 * - **DSH has no project-scoped plugin config.** `packages/settings/settings`
 *   has no workspace scope, and bundles and patch layers are profile-level. The
 *   only per-project file convention the harness has is `AGENTS.md` /
 *   `CLAUDE.md` (`packages/context/agent-instructions/src/config.ts:12`), which
 *   carries *prose instructions*, not configuration.
 * - **`jj` has a per-repo config, but not where you can see it.**
 *   `jj config set --repo` writes to
 *   `~/.config/jj/repos/<hash>/config.toml` — verified on 0.46.0. It is
 *   per-repo, but it lives outside the workspace, cannot be committed, and
 *   reading it needs either a `jj` subprocess or a reimplementation of `jj`'s
 *   path hashing.
 *
 * So the switch is this plugin's own convention. That is a real cost — a
 * convention nobody else knows — and it is why the file is named after the
 * package and documented in one place.
 *
 * ## Semantics
 *
 * The **nearest** marker walking up from the effective directory wins, so a
 * marker deep in the tree overrides one above it:
 *
 * | Marker | Effect |
 * |---|---|
 * | `{"enabled": false}` | the plugin is completely off in this subtree |
 * | `{"enabled": true}` | the plugin is on, overriding an ancestor's `false` |
 * | `{"adopt": true\|false}` | overrides the global `adoptGitRepos` setting here |
 * | absent | automatic — the plugin follows `.jj` presence |
 *
 * `true` matters because it is what makes a subtree exemption possible: disable
 * a monorepo once, re-enable one vendored `jj` repo inside it, without touching
 * the outer marker.
 *
 * ## Cost
 *
 * One `stat` per directory on the way up, plus one `readText` on the hit, and
 * the answer is cached per directory. The walk is the same shape as detection's
 * and is dropped by the same invalidation.
 *
 * ## Why JSON and not TOML
 *
 * `jj` uses TOML and this file sits next to it, so TOML would be the neighbourly
 * choice. There is no TOML parser in this plugin's dependency set or in the
 * harness packages read, and adding a dependency to parse one boolean is a worse
 * trade than a JSON file whose only key is documented here.
 *
 * @module dsh-jujutsu/marker
 */

import type { Context } from "@deepseek-ai/cordis";

/** The marker's file name, at any directory level. */
export const MARKER_FILE = ".dsh-jujutsu.json";

/** How far up to look. Matches detection's bound, for the same reason. */
const MAX_DEPTH = 64;

export interface Marker {
  /** `true` forces the plugin on, `false` forces it off. */
  readonly enabled: boolean;
  /**
   * Overrides the global `adoptGitRepos` setting for this project.
   *
   * `false` is the useful direction: the global setting makes the plugin write
   * `.jj` into every plain Git repository a session opens, and a monorepo or a
   * vendored checkout is exactly where that should not happen. `true` is the
   * other direction, so a single project can opt in without turning the setting
   * on everywhere.
   */
  readonly adopt?: boolean;
  /** The directory holding the marker. */
  readonly dir: string;
}

/**
 * How long a lookup may be trusted before the walk is repeated.
 *
 * Short, because a marker is a human switch: someone who writes one expects it
 * to take effect, not to take effect after a restart. The walk is a `stat` per
 * directory, so repeating it a few times a minute is not a cost worth caching
 * staleness for.
 */
const TTL_MS = 2_000;

/** Directory → the marker found for it, or `null` when there is none. */
const CACHE = new Map<string, { readonly value: Marker | null; readonly at: number }>();

/** Drop every cached lookup. Called alongside `invalidateDetection`. */
export function invalidateMarkers(): void {
  CACHE.clear();
}

/**
 * Find the governing marker for a directory.
 *
 * @param ctx - plugin context, for `ctx.fs`.
 * @param start - absolute directory to begin at.
 * @returns the nearest marker, or `undefined` when none is found.
 */
export async function markerFor(ctx: Context, start: string): Promise<Marker | undefined> {
  const entry = CACHE.get(start);
  if (entry !== undefined && Date.now() - entry.at < TTL_MS) {
    return entry.value ?? undefined;
  }

  const found = await walk(ctx, start);
  CACHE.set(start, { value: found ?? null, at: Date.now() });
  return found;
}

async function walk(ctx: Context, start: string): Promise<Marker | undefined> {
  let dir = start.endsWith("/") && start.length > 1 ? start.slice(0, -1) : start;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const marker = await readMarker(ctx, dir);
    if (marker !== undefined) return marker;

    const parent = parentOf(dir);
    if (parent === undefined) return undefined;
    dir = parent;
  }
  return undefined;
}

/** The parent directory, or `undefined` at the filesystem root. */
function parentOf(dir: string): string | undefined {
  if (dir === "/" || dir === "") return undefined;
  const at = dir.lastIndexOf("/");
  if (at < 0) return undefined;
  return at === 0 ? "/" : dir.slice(0, at);
}

/**
 * Read and parse one directory's marker.
 *
 * Every failure is "no marker": an absent file, an unreadable one, malformed
 * JSON, or a JSON value that is not an object with a boolean `enabled`. A
 * switch that a typo can turn into a hard error is a switch nobody dares use,
 * and the safe reading of an unparseable opt-out is to keep the plugin on
 * rather than to silently disable protection.
 */
async function readMarker(ctx: Context, dir: string): Promise<Marker | undefined> {
  const path = `${dir}/${MARKER_FILE}`;
  try {
    // `ctx.get('fs')`, matching `detect.ts`: the service is not part of the
    // `Context` type unless `dsh-fs`'s augmentation is in scope, and this plugin
    // declares no dependency on it.
    const fs = ctx.get("fs");
    if (fs === undefined) return undefined;

    const target = await fs.resolve(path);
    const info = await fs.stat(target);
    if (info === undefined || info.type !== "file") return undefined;

    const parsed: unknown = JSON.parse(await fs.readText(target));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const enabled = (parsed as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") return undefined;
    // `adopt` is optional and independently typed: a marker with only
    // `{"enabled": true}` still means "follow the global adoption setting", and
    // a non-boolean `adopt` is ignored rather than failing the whole marker.
    const adopt = (parsed as { adopt?: unknown }).adopt;
    return typeof adopt === "boolean" ? { enabled, adopt, dir } : { enabled, dir };
  } catch {
    return undefined;
  }
}
