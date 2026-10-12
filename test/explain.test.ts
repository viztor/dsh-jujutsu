/**
 * The explainer — the second channel, and the only place an approval is
 * remembered.
 *
 * `tools/pre-execute` decides; `tools/post-execute` learns. This file covers the
 * half that learns, which nothing tested before: an asked call that then *ran*
 * is an approved call, and the verb is remembered for the rest of the session so
 * the user is not asked about it again.
 *
 * It also pins an absence. `Message.explain` is never populated — the source
 * docs define no long-form text, and inventing one would not be transcription —
 * so the branch that attaches `additionalContexts` cannot fire today. That is
 * recorded as a test rather than a comment, because the day someone adds explain
 * text the branch becomes live and this file should say so.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { forget } from "../src/bypass.ts";
import { invalidateDetection } from "../src/detect.ts";
import { apply } from "../src/index.ts";
import { invalidateMarkers } from "../src/marker.ts";
import { VERB_ROWS } from "../src/messages.ts";
import { FIXTURES, fakeHarness, HAS_FIXTURES } from "./helpers.ts";

const CWD = `${FIXTURES}/jj-colocated`;

/** A read-only Git call, which `readOnlyGit` governs. */
function statusCall(harness: ReturnType<typeof fakeHarness>) {
  return harness.session("s1", CWD).exec("bash", {
    command: "git status",
    description: "test",
  });
}

beforeEach(() => {
  forget();
  invalidateDetection();
  invalidateMarkers();
});

describe.skipIf(!HAS_FIXTURES)("an approved call is remembered", () => {
  it("asks once, then allows the same verb without asking", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const first = statusCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");

    // The call ran, so the user approved it.
    await h.postExecute(first, { isError: false });

    // The same verb now goes through untouched.
    const second = statusCall(h);
    expect((await h.preExecute(second)).kind).toBe("allow");
  });

  it("forgets nothing when the approved call failed", async () => {
    // An error is not an approval. Remembering on failure would silently widen
    // the bypass to a command the user never actually saw succeed.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const first = statusCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");
    await h.postExecute(first, { isError: true });

    const second = statusCall(h);
    expect((await h.preExecute(second)).kind).toBe("ask");
  });

  it("does not remember at all when the setting is off", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: false });

    const first = statusCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");
    await h.postExecute(first, { isError: false });

    const second = statusCall(h);
    expect((await h.preExecute(second)).kind).toBe("ask");
  });

  it("leaves a call the guard never decided alone", async () => {
    // A `jj` command is not the guard's business, so nothing was marked pending
    // and the explainer must pass it straight through.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const exec = h.session("s1", CWD).exec("bash", {
      command: "jj status",
      description: "test",
    });
    expect((await h.preExecute(exec)).kind).toBe("allow");
    expect(await h.postExecute(exec, { isError: false })).toEqual({ kind: "accept" });
  });
});

describe.skipIf(!HAS_FIXTURES)("the long-form branch is unreachable, deliberately", () => {
  it("populates no `explain` on any message", () => {
    // The explainer attaches `additionalContexts` only when a refusal carries an
    // `explain`. Nothing does, because `docs/25` §2 defines two strings per
    // message and no long-form text. If this ever fails, the branch above has
    // become live and needs a test of its own.
    const withExplain = VERB_ROWS.filter((row) => row.message.explain !== undefined);
    expect(withExplain.map((row) => row.match.join(" "))).toEqual([]);
  });
});
