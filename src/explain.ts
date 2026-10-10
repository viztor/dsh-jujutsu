/**
 * The denial's **second channel**, and the place an approval is learned.
 *
 * ## Why a second channel exists
 *
 * A guard denial reaches the model as `Error: <reason>` — but the denied call is
 * then run through the `tools/post-execute` waterfall anyway, so a listener here
 * can attach the explanation to that same result. Confirmed live in
 * `docs/35-probe-results-live.md`: the attached text arrives as an
 * `agent/inbox/spliced` record.
 *
 * So the guard splits its message:
 *
 * | Channel | Carries | Bound |
 * |---|---|---|
 * | `reason` on the `deny` | the actionable command — what the model needs now | ≤ 240 chars |
 * | `additionalContexts` from here | the explanation — why Git is wrong here, what `jj` does instead | none |
 *
 * **The explanation is currently unset on every message.** `docs/25` §2 defines
 * no long-form text, and the only other wording that exists — `docs/15` §1's
 * message column — is the *superseded draft*, so shipping it here would put
 * stale copy in a shipped field. The channel is wired and verified; the copy is
 * a documentation task (`docs/25` needs a §2.4).
 *
 * ## Why an approval is learned here
 *
 * `allowed-once` is per call, so a user who approves a verb is asked again next
 * time. The only place the plugin can observe that an ask was *approved* is
 * here: an asked call whose result is **not an error** is a call that ran, which
 * means the user said yes. That is what feeds `bypass.ts`.
 *
 * ## Two constraints, both from the same code
 *
 * - Return `{kind:'accept', additionalContexts}` with **no `value`**. The `value`
 *   branch throws `tools/post-execute cannot replace the value of a failed
 *   result` on an error result (`dsh-tools/lib/index.js:3517-3518`).
 * - Prefer `accept` over `{kind:'block', feedback}`: `block` recomputes
 *   `error.message` from the feedback (`:3506-3513`), **discarding the guard's
 *   `reason`** — the terse actionable line the whole design rests on.
 *
 * @module dsh-jujutsu/explain
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

import { remember } from "./bypass.ts";
import type { Settings } from "./settings.ts";
import type { Refusal } from "./verbs.ts";

interface Pending {
  readonly refusal: Refusal;
  readonly asked: boolean;
}

/**
 * Executions the guard refused, so this listener knows which results to enrich.
 *
 * A `WeakMap` keyed on the execution object: it needs no cleanup and cannot
 * leak, and the same object is passed to both waterfalls.
 */
const PENDING = new WeakMap<object, Pending>();

/** Record that the guard refused this call outright. */
export function markDenied(exec: ToolExecution, refusal: Refusal): void {
  PENDING.set(exec, { refusal, asked: false });
}

/** Record that the guard asked the user about this call. */
export function markAsked(exec: ToolExecution, refusal: Refusal): void {
  PENDING.set(exec, { refusal, asked: true });
}

/** What did the guard decide about this call? */
export function pendingOf(exec: ToolExecution): Pending | undefined {
  return PENDING.get(exec);
}

/** Register the explainer. */
export function applyExplain(ctx: Context, settings: Settings): void {
  if (settings.guard === "off") return;

  ctx.on("tools/post-execute", async (exec, result, next) => {
    try {
      const pending = PENDING.get(exec);
      if (pending === undefined) return next();

      // An asked call that ran is an approved call. Remember the verb so the
      // user is not asked about it again in this session.
      if (pending.asked && result.isError !== true) {
        const sessionId = exec.agent?.session.id;
        if (settings.rememberBypass && sessionId !== undefined) {
          remember(sessionId, pending.refusal.verb);
        }
        return next();
      }

      const explain = pending.refusal.message.explain;
      if (explain === undefined) return next();

      return {
        kind: "accept",
        additionalContexts: [
          createUserMessage({
            content: [{ type: "text", text: explain }],
            source: { kind: "user" },
          }),
        ],
      };
    } catch {
      // Never let the explainer change the outcome of a call it did not decide.
    }
    return next();
  });
}
