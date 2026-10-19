/**
 * The resolved configuration.
 *
 * `Config` in `config.ts` is the *schema* — it is what Cordis validates the
 * patch row against and what the settings projection renders. `Settings` is the
 * *narrowed value* the rest of the plugin consumes, produced by
 * {@link resolveSettings} from a raw, possibly-unvalidated row.
 *
 * The narrowing is deliberately permissive: a missing or malformed field falls
 * back to the schema default rather than disabling the plugin, so a malformed
 * row can never silently remove protection.
 *
 * @module dsh-jujutsu/settings
 */

import { isRecord } from "./guard-utils.ts";

export interface Settings {
  readonly guard: boolean;
  readonly readOnlyGit: "deny" | "ask" | "allow";
  readonly bypass: "ask" | "deny" | "allow";
  readonly rememberBypass: boolean;
  readonly jjPath: string;
  readonly jjHunkPath: string;
  readonly hunkInstall: "ask" | "never" | "auto";
  readonly teachSkill: boolean;
  readonly injectContext: boolean;
  /** Say so when a directory has no version control at all. */
  readonly alertUninitialised: boolean;
  /** Which to suggest when initialising. */
  readonly preferJj: boolean;
  /** Adopt plain Git repositories for Jujutsu (`jj git init --colocate`). */
  readonly adoptGitRepos: boolean;
}

const READ_ONLY = ["deny", "ask", "allow"] as const;
const INSTALL = ["ask", "never", "auto"] as const;

/** Narrow one enum field, falling back to `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Resolve a raw config row into {@link Settings}.
 *
 * @param raw - the value Cordis handed to `apply`, which may be anything.
 */
export function resolveSettings(raw: unknown): Settings {
  const row = isRecord(raw) ? raw : {};
  return {
    guard: row.guard !== false,
    readOnlyGit: oneOf(row.readOnlyGit, READ_ONLY, "ask"),
    bypass: oneOf(row.bypass, READ_ONLY, "ask"),
    rememberBypass: boolean(row.rememberBypass, true),
    jjPath: string(row.jjPath, "jj"),
    jjHunkPath: string(row.jjHunkPath, "jj-hunk"),
    hunkInstall: oneOf(row.hunkInstall, INSTALL, "ask"),
    teachSkill: boolean(row.teachSkill, true),
    injectContext: boolean(row.injectContext, true),
    alertUninitialised: boolean(row.alertUninitialised, true),
    preferJj: boolean(row.preferJj, true),
    adoptGitRepos: boolean(row.adoptGitRepos, false),
  };
}
