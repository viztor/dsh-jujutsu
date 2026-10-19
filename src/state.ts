/**
 * The per-session workspace state the prompt renders.
 *
 * `ctx.systemPrompt`'s providers are **synchronous** — `text` is
 * `string | ((context) => string)`, never a promise — but detection, the change
 * ID, and the `jj-hunk` probe are all asynchronous. So they are gathered once,
 * asynchronously, and cached here for the provider to read.
 *
 * That gathering happens at `agent/created` (see `preflight.ts`), which is the
 * one seam that is awaited before session creation resolves and already has
 * `SessionHeader.cwd`.
 *
 * ## Why the state names a VCS rather than only a workspace
 *
 * The plugin used to record only "is this a `jj` workspace", so a directory with
 * no version control at all was indistinguishable from one it had merely failed
 * to detect — and it said nothing in either case. Naming the VCS makes the third
 * case expressible, which is what lets the plugin tell the model that the work
 * it is doing has no history at all.
 *
 * @module dsh-jujutsu/state
 */

import type { AdoptFailure } from "./adopt.ts";
import type { VcsKind, WorkspaceKind } from "./detect.ts";

/**
 * What happened when the plugin tried to hand a plain Git repo to Jujutsu.
 *
 * Recorded per session because it is the one thing the prompt must say that
 * cannot be re-derived synchronously: whether `.jj` was created a moment ago,
 * or whether adoption was refused and why. `context.ts` renders from this.
 */
export interface AdoptionState {
  readonly status: "adopted" | "blocked";
  /** Set only when `status` is `blocked`. */
  readonly blocker?: AdoptFailure;
  /** The concrete file or message behind the blocker, for the prompt. */
  readonly evidence?: string;
}

export interface WorkspaceState {
  /** What governs the directory: `jj`, plain `git`, or nothing. */
  readonly vcs: VcsKind;
  /** The `jj` workspace root, the Git repo root, or the directory itself. */
  readonly root: string;
  /** Set only when `vcs` is `jj`. */
  readonly kind?: Exclude<WorkspaceKind, "none">;
  /** Short change ID of `@`, when `jj` could be asked. */
  readonly changeId?: string;
  /** Whether `jj-hunk` resolved. */
  readonly jjHunk?: boolean;
  /** Present only when this session adopted a Git repo, or tried to. */
  readonly adoption?: AdoptionState;
  /**
   * Whether `jj` is refused outside a Jujutsu workspace here.
   *
   * The effective value of the global setting overridden by the project marker.
   * Recorded because the prompt is the only place the model is told *why* a `jj`
   * command will be refused before it tries one, and because the guard learns the
   * same answer from the same two sources.
   */
  readonly forceJj?: boolean;
}

/** session id → state. Sessions are few and long-lived, so a plain Map is right. */
const STATES = new Map<string, WorkspaceState>();

/** Record the state gathered for one session. */
export function setWorkspaceState(sessionId: string, state: WorkspaceState): void {
  STATES.set(sessionId, state);
}

/** The state for one session, if it has been gathered yet. */
export function workspaceState(sessionId: string): WorkspaceState | undefined {
  return STATES.get(sessionId);
}

/** Drop every cached state. For session teardown and for tests. */
export function clearWorkspaceState(): void {
  STATES.clear();
}
