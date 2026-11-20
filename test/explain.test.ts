/**
 * The explainer — the second channel, and the only place an approval is
 * remembered.
 *
 * `tools/pre-execute` decides; `tools/post-execute` learns. This file covers the
 * half that learns, which nothing tested before: an asked call that then *ran*
 * is an approved call, and the verb is remembered for the rest of the session so
 * the user is not asked about it again. A read-only approval is remembered as a
 * **class** as well, so approving `git status` also stops `git log` from asking;
 * mutating commands stay per-verb.
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

/** A different read-only verb, to prove the class — not the verb — is remembered. */
function logCall(harness: ReturnType<typeof fakeHarness>) {
  return harness.session("s1", CWD).exec("bash", {
    command: "git log --oneline -3",
    description: "test",
  });
}

/** A mutating Git call, which `bypass` governs. */
function commitCall(harness: ReturnType<typeof fakeHarness>) {
  return harness.session("s1", CWD).exec("bash", {
    command: "git commit -m x",
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
    // The class layer must not learn from a failure either.
    expect((await h.preExecute(logCall(h))).kind).toBe("ask");
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

describe.skipIf(!HAS_FIXTURES)("a read-only approval is remembered as a class", () => {
  it("allows a different read-only verb after one read-only approval", async () => {
    // The complaint this layer answers: approving `git status` used to leave
    // `git log` asking, because the memory was keyed on the verb alone. The
    // user's answer was about *looking*, so it covers the read-only surface.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const first = statusCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");
    await h.postExecute(first, { isError: false });

    expect((await h.preExecute(logCall(h))).kind).toBe("allow");
  });

  it("still asks about a mutating verb", async () => {
    // The class is read-only only. A user who let the model look did not let it
    // write, so `git commit` is still a question.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const first = statusCall(h);
    await h.preExecute(first);
    await h.postExecute(first, { isError: false });

    expect((await h.preExecute(commitCall(h))).kind).toBe("ask");
  });

  it("does not remember the class from a mutating approval", async () => {
    // The converse boundary: approving `git commit` says nothing about looking,
    // so it must not open the read-only surface.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const first = commitCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");
    await h.postExecute(first, { isError: false });

    expect((await h.preExecute(logCall(h))).kind).toBe("ask");
  });

  it("does not remember the class when the setting is off", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: false });

    const first = statusCall(h);
    expect((await h.preExecute(first)).kind).toBe("ask");
    await h.postExecute(first, { isError: false });

    expect((await h.preExecute(logCall(h))).kind).toBe("ask");
  });

  it("does not let a listing-form approval open the mutating form of the same verb", async () => {
    // `branch` names both a listing form (`git branch`) and a mutating one
    // (`git branch -d feat`). The per-verb layer keys on the verb *and* the
    // read-only flag, so approving the listing must not approve the delete —
    // and the class layer is gated on `readOnly`, so it cannot either.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", readOnlyGit: "ask", rememberBypass: true });

    const listing = h.session("s1", CWD).exec("bash", {
      command: "git branch",
      description: "test",
    });
    expect((await h.preExecute(listing)).kind).toBe("ask");
    await h.postExecute(listing, { isError: false });

    const deleting = h.session("s1", CWD).exec("bash", {
      command: "git branch -d feat",
      description: "test",
    });
    expect((await h.preExecute(deleting)).kind).toBe("ask");
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
