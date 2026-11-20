/**
 * The session-scoped bypass memory.
 *
 * `allowed-once` is per call **by design** — the approval service has no
 * "always allow" outcome (`docs/17-bypass-and-approval.md`). So a user who
 * genuinely wants a handful of Git commands is prompted once per command, which
 * is correct and annoying in equal measure.
 *
 * This module is the plugin's own answer, in two layers:
 *
 * - **Per verb.** When a user approves an `ask`, the verb is remembered for the
 *   rest of the session and the guard stops asking about it. This is what keeps
 *   `git commit` from being asked about twice.
 * - **Per class, for read-only commands only.** Approving `git status` also
 *   approves `git log`: a user who has agreed to let the model *look* with Git
 *   has agreed to the whole read-only surface, and being asked once per
 *   read-only verb is the complaint this layer answers. Mutating commands are
 *   deliberately **not** class-remembered — approving `git commit` must not
 *   approve `git push` — so they stay on the per-verb layer.
 *
 * That is a real widening of a permission, so:
 *
 * - it is **in memory only** — there is no per-workspace store to persist to,
 *   and the only durable medium is global to the whole DSH home, which would
 *   silently widen the grant to every project under it
 *   (`docs/29-state-config-and-sandbox-surfaces.md` §1);
 * - it is keyed by session, so a grant never crosses sessions;
 * - the per-verb layer is keyed by **verb *and* read-only-ness**, because a verb
 *   can have both a listing form and a mutating one — `git branch` reads,
 *   `git branch -d` writes. Keying on the verb alone would let an approval of
 *   the listing form open the mutating one;
 * - the class layer is consulted only for a refusal the classifier marked
 *   `readOnly`, so it cannot open a mutating form of a read-only verb;
 * - it can be switched off with `rememberBypass: false`.
 *
 * The outcome is learned from `tools/post-execute`: a call the guard asked about
 * that then *ran successfully* is a call the user approved.
 *
 * @module dsh-jujutsu/bypass
 */

/** session id → the (verb, read-only-ness) pairs the user has approved in it. */
const ALLOWED = new Map<string, Set<string>>();

/**
 * The key the per-verb layer stores.
 *
 * The read-only flag is part of the key, not decoration: `branch` names both a
 * listing form (`git branch`) and a mutating one (`git branch -d feat`), and an
 * approval of the first must not open the second. A NUL separator cannot occur
 * in a Git subcommand, so no two pairs can collide.
 */
function keyOf(verb: string, readOnly: boolean): string {
  return `${verb}\u0000${readOnly ? "read" : "write"}`;
}

/**
 * Sessions in which the user has approved at least one read-only Git command.
 *
 * A set of session ids rather than a flag on the session object: the plugin
 * never owns the session, and this is the whole state the class layer needs.
 */
const READ_ONLY = new Set<string>();

/** Remember that the user approved `verb` in `session`. */
export function remember(sessionId: string, verb: string, readOnly: boolean): void {
  const verbs = ALLOWED.get(sessionId) ?? new Set<string>();
  verbs.add(keyOf(verb, readOnly));
  ALLOWED.set(sessionId, verbs);
}

/** Has the user already approved this verb, in this read-only-ness, in this session? */
export function isRemembered(sessionId: string, verb: string, readOnly: boolean): boolean {
  return ALLOWED.get(sessionId)?.has(keyOf(verb, readOnly)) ?? false;
}

/**
 * Remember that the user approved a read-only Git command in `session`.
 *
 * Called for the **class**, not the verb: the caller has already established
 * that the approved command only reads, and one such approval is the whole
 * grant. There is no per-verb bookkeeping here — the verb layer above already
 * records the exact command, and this layer exists precisely so a *different*
 * read-only verb does not ask again.
 */
export function rememberReadOnly(sessionId: string): void {
  READ_ONLY.add(sessionId);
}

/** Has the user approved any read-only Git command in this session? */
export function isReadOnlyRemembered(sessionId: string): boolean {
  return READ_ONLY.has(sessionId);
}

/** Drop every remembered grant. For tests, and for session teardown. */
export function forget(): void {
  ALLOWED.clear();
  READ_ONLY.clear();
}
