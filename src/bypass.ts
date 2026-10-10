/**
 * The session-scoped bypass memory.
 *
 * `allowed-once` is per call **by design** — the approval service has no
 * "always allow" outcome (`docs/17-bypass-and-approval.md`). So a user who
 * genuinely wants a handful of Git commands is prompted once per command, which
 * is correct and annoying in equal measure.
 *
 * This module is the plugin's own answer: when a user approves an `ask`, the
 * verb is remembered for the rest of the session and the guard stops asking
 * about it. That is a real widening of a permission, so:
 *
 * - it is **in memory only** — there is no per-workspace store to persist to,
 *   and the only durable medium is global to the whole DSH home, which would
 *   silently widen the grant to every project under it
 *   (`docs/29-state-config-and-sandbox-surfaces.md` §1);
 * - it is keyed by session **and** verb, so approving `git status` never
 *   approves `git push`;
 * - it can be switched off with `rememberBypass: false`.
 *
 * The outcome is learned from `tools/post-execute`: a call the guard asked about
 * that then *ran successfully* is a call the user approved.
 *
 * @module dsh-jujutsu/bypass
 */

/** session id → the verbs the user has approved in it. */
const ALLOWED = new Map<string, Set<string>>();

/** Remember that the user approved `verb` in `session`. */
export function remember(sessionId: string, verb: string): void {
  const verbs = ALLOWED.get(sessionId) ?? new Set<string>();
  verbs.add(verb);
  ALLOWED.set(sessionId, verbs);
}

/** Has the user already approved this verb in this session? */
export function isRemembered(sessionId: string, verb: string): boolean {
  return ALLOWED.get(sessionId)?.has(verb) ?? false;
}

/** Drop every remembered grant. For tests, and for session teardown. */
export function forget(): void {
  ALLOWED.clear();
}

/** How many grants are held, for tests. */
export function grantCount(): number {
  let total = 0;
  for (const verbs of ALLOWED.values()) total += verbs.size;
  return total;
}
