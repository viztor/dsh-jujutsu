/**
 * Reading the current workspace name out of `jj workspace list`.
 *
 * The plain listing is the only form that marks the current workspace, so it is
 * the source both `jj_status` and the preflight read. Its shape has changed
 * across jj releases:
 *
 * ```text
 * agent-a (current): .  tkxryxrv 83bd0baf (empty)   # jj 0.47+
 * agent-a: .  tkxryxrv 83bd0baf (empty)             # earlier
 * default: ../other  tmqpnvqm 36849269 (empty)
 * ```
 *
 * The current row is the one whose **path column is `.`**; the `(current)`
 * annotation is decoration and may or may not be present. Matching the name as
 * `^(\S+):` therefore broke on the annotated form — the colon follows
 * `(current)`, not the name — which silently turned every `jj_status` workspace
 * into `null` on jj 0.47. Split on the first `": "` and strip the annotation
 * instead: that reads both shapes and does not depend on the annotation's
 * wording.
 *
 * @module dsh-jujutsu/workspace
 */

/** The `(current)` annotation jj may append to the current workspace's name. */
const CURRENT_ANNOTATION = / \(current\)$/;

/**
 * The name of the workspace whose path column is `.`.
 *
 * @param stdout - the plain `jj workspace list` output.
 * @returns the current workspace's name, or `undefined` when no row is current.
 */
export function currentWorkspaceNameFrom(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const path = line.slice(separator + 2);
    // The path column is `.` exactly, followed by the change and commit ids.
    if (path !== "." && !path.startsWith(". ")) continue;
    return line.slice(0, separator).replace(CURRENT_ANNOTATION, "");
  }
  return undefined;
}
