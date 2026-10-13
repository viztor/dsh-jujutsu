/**
 * The `hunkInstall` flow: what happens when `jj-hunk` is not installed.
 *
 * `docs/19` specifies this in full and none of it existed — the setting was
 * declared, typed, documented in the README, and **read nowhere**. These tests
 * are the four branches that document names, plus the caching rule.
 *
 * They do **not** use the real shell double. `fakeHarness`'s shell runs commands
 * for real, which here would mean running `cargo install` — the actual thing this
 * feature is careful about. Every test below scripts the shell instead, so
 * nothing is installed and no PATH is consulted.
 */

import { afterEach, describe, expect, it } from "vitest";

import { applyTools } from "../src/tools.ts";
import { forgetInstallAnswers } from "../src/hunk.ts";
import { resolveSettings } from "../src/settings.ts";
import { fakeHarness } from "./helpers.ts";

afterEach(() => {
  forgetInstallAnswers();
});

/** A shell double that answers by command prefix, and records what it ran. */
function scriptedShell(
  responses: (command: string) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const ran: string[] = [];
  return {
    ran,
    mount(ctx: unknown) {
      const shell = {
        resolve: (request: { command: string; workdir?: string }) => request,
        execute: async (spec: { command: string; workdir?: string }) => ({
          result: async () => {
            ran.push(spec.command);
            const answer = responses(spec.command);
            return {
              exitCode: answer.exitCode,
              signal: null,
              timedOut: false,
              stdout: { text: answer.stdout ?? "", truncated: false },
              stderr: { text: answer.stderr ?? "", truncated: false },
            };
          },
        }),
      };
      const target = ctx as { get: (n: string) => unknown };
      const get = target.get;
      target.get = (name: string) => (name === "shell" ? shell : get.call(target, name));
    },
  };
}

/** A `ctx.userQuestions` double that answers with the given label. */
function questions(answer: string | undefined) {
  const asked: unknown[] = [];
  return {
    asked,
    service: {
      ask: async (request: unknown) => {
        asked.push(request);
        if (answer === undefined) throw new Error("DELEGATED_CALLER");
        return { answers: [{ id: "dsh-jujutsu.jj-hunk-install", selected: [answer] }] };
      },
    },
  };
}

/** A harness whose shell is scripted and whose `jj-hunk` starts failing. */
function harnessWith(
  options: {
    readonly config?: Record<string, unknown>;
    readonly cargoMissing?: boolean;
    readonly installFails?: boolean;
    readonly retryWorks?: boolean;
    readonly answer?: string | undefined;
  } = {},
) {
  const harness = fakeHarness();
  let attempted = 0;
  // `shellQuote` wraps every argument, so the command string is
  // `'cargo' '--version'` — not `cargo --version`. Matching the unquoted form
  // silently fell through to the default branch, which is how the first version
  // of these tests reported CARGO_MISSING everywhere.
  const shell = scriptedShell((command) => {
    if (command.includes("'cargo'") && command.includes("'--version'")) {
      return options.cargoMissing === true
        ? { exitCode: 127, stderr: "cargo: not found" }
        : { exitCode: 0, stdout: "cargo 1.90.0" };
    }
    if (command.includes("'cargo'") && command.includes("'install'")) {
      return options.installFails === true
        ? { exitCode: 101, stderr: "error: failed to compile" }
        : { exitCode: 0 };
    }
    // `jj-hunk`: not found until an install has happened, then it works.
    attempted += 1;
    const installed = shell.ran.some((c) => c.includes("'install'"));
    if (installed && options.retryWorks !== false) return { exitCode: 0, stdout: '{"files":[]}' };
    return { exitCode: 127, stderr: "jj-hunk: not found" };
  });
  shell.mount(harness.ctx);

  const q = questions(options.answer);
  const target = harness.ctx as unknown as { get: (n: string) => unknown };
  const get = target.get;
  target.get = (name: string) => (name === "userQuestions" ? q.service : get.call(target, name));

  const settings = resolveSettings({ hunkInstall: "ask", ...options.config });
  applyTools(harness.ctx, settings);
  return { harness, settings, shell, q, attempts: () => attempted };
}

/** Call `jj_hunk_list` and return its outcome. */
async function callList(harness: ReturnType<typeof harnessWith>) {
  const { buildToolDefinitions } = await import("../src/tools.ts");
  const defs = buildToolDefinitions(harness.harness.ctx, harness.settings);
  const tool = defs.find((d) => d.name === "jj_hunk_list") as
    | { execute: (a: unknown, e: unknown) => Promise<unknown> }
    | undefined;
  return (await tool?.execute(
    { query: "added()" },
    harness.harness.session("s1", "/tmp").exec("bash", {}),
  )) as { error?: { code: string; message: string; hint?: string } } | undefined;
}

describe("hunkInstall: never", () => {
  it("reports the command without asking", async () => {
    const h = harnessWith({ config: { hunkInstall: "never" } });
    const outcome = await callList(h);
    expect(outcome?.error?.code).toBe("JJ_HUNK_MISSING");
    expect(outcome?.error?.hint).toContain("--tag v0.5.1");
    expect(h.q.asked, "no question when the user said never").toEqual([]);
  });
});

describe("hunkInstall: ask, with no cargo", () => {
  it("names the Rust toolchain instead of offering an install", async () => {
    // Offering an install that cannot run is worse than not offering: the user
    // says yes and nothing happens.
    const h = harnessWith({ cargoMissing: true });
    const outcome = await callList(h);
    expect(outcome?.error?.code).toBe("CARGO_MISSING");
    expect(outcome?.error?.hint).toContain("rustup");
    expect(h.q.asked, "nothing to ask about").toEqual([]);
  });
});

describe("hunkInstall: ask, and the human says yes", () => {
  it("installs the pinned tag, then retries once and succeeds", async () => {
    const h = harnessWith({ answer: "Install now" });
    const outcome = await callList(h);

    const install = h.shell.ran.find((c) => c.includes("'install'"));
    expect(install, "the install ran").toBeDefined();
    // The pinned tag, not the crate: the crate is two versions behind with a
    // different CLI, and an unpinned --git builds whatever main is today.
    expect(install).toContain("'--tag' 'v0.5.1'");
    // From git, not `cargo install jj-hunk` — the crate is the wrong tool.
    expect(install).toContain("'--git'");

    expect(outcome?.error, "the retry succeeded").toBeUndefined();
    expect(h.attempts(), "one failure, one retry — not a loop").toBe(2);
  });
});

describe("hunkInstall: ask, and the human declines", () => {
  it("stops, and does not ask again in the same session", async () => {
    const h = harnessWith({ answer: "Never ask again" });
    const first = await callList(h);
    expect(first?.error?.code).toBe("JJ_HUNK_INSTALL_DECLINED");

    const second = await callList(h);
    expect(second?.error?.code).toBe("JJ_HUNK_INSTALL_DECLINED");
    expect(h.q.asked, "asked once per session, not once per call").toHaveLength(1);
    expect(h.shell.ran.some((c) => c.includes("'install'"))).toBe(false);
  });
});

describe("hunkInstall: ask, but nobody can be asked", () => {
  it("falls back to the instruction rather than an error about asking", async () => {
    // A subagent cannot raise a question. `docs/19` requires the instruction in
    // that case, because an error about asking would be about the wrong thing.
    const h = harnessWith({ answer: undefined });
    const outcome = await callList(h);
    expect(outcome?.error?.code).toBe("JJ_HUNK_MISSING");
    expect(outcome?.error?.hint).toContain("--tag v0.5.1");
    expect(h.shell.ran.some((c) => c.includes("'install'"))).toBe(false);
  });
});

describe("hunkInstall: the install itself fails", () => {
  it("reports the tail of cargo's output", async () => {
    const h = harnessWith({ answer: "Install now", installFails: true });
    const outcome = await callList(h);
    expect(outcome?.error?.code).toBe("JJ_HUNK_INSTALL_FAILED");
    expect(outcome?.error?.message).toContain("failed to compile");
  });
});
