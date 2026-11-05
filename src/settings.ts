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
  /**
   * Refuse `jj` invocations outside a Jujutsu workspace.
   *
   * On, the guard answers with the command that makes the invocation possible
   * (`jj git init --colocate`) instead of letting `jj` exit with "There is no jj
   * repo in "." — a call the model cannot learn anything from.
   */
  readonly forceJj: boolean;
  /** Which tool tier to register: minimal, core, or the full agent surface. */
  readonly toolset: "minimal" | "core" | "full";
  /** Directories `jj_test` copy-on-write clones into its ephemeral workspace. */
  readonly verifyCloneDirs: readonly string[];
  /** What `jj_publish` may do with `git push`. */
  readonly publish: "deny" | "ask" | "allow";
  /** Bookmark prefix recording which agent owns a workspace; empty disables. */
  readonly agentBookmarkPrefix: string;
  /** Directory `jj_workspace add` uses when no path is passed. */
  readonly workspaceRoot: string;
  /** How strongly to enforce workspace ownership. */
  readonly coordination: "off" | "advise" | "enforce";
  /** Default grouping action jj_coordinate suggests. */
  readonly groupDefault: "merge" | "stack";
}

const READ_ONLY = ["deny", "ask", "allow"] as const;
const INSTALL = ["ask", "never", "auto"] as const;
const TOOLSET = ["minimal", "core", "full"] as const;
const PUBLISH = ["deny", "ask", "allow"] as const;
const COORDINATION = ["off", "advise", "enforce"] as const;
const GROUP_DEFAULT = ["merge", "stack"] as const;

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

/** Narrow a string array, dropping empty entries; fall back when absent. */
function strings(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? out : fallback;
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
    forceJj: boolean(row.forceJj, false),
    toolset: oneOf(row.toolset, TOOLSET, "full"),
    verifyCloneDirs: strings(row.verifyCloneDirs, ["node_modules"]),
    publish: oneOf(row.publish, PUBLISH, "ask"),
    agentBookmarkPrefix:
      typeof row.agentBookmarkPrefix === "string" ? row.agentBookmarkPrefix : "agent/",
    workspaceRoot: string(row.workspaceRoot, ".."),
    coordination: oneOf(row.coordination, COORDINATION, "advise"),
    groupDefault: oneOf(row.groupDefault, GROUP_DEFAULT, "merge"),
  };
}
