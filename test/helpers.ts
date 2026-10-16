/**
 * Test doubles for the harness seams.
 *
 * The plugin reads a handful of things from the harness — `ctx.fs`, `ctx.on`,
 * `ctx.get('approval')`, and two `ctx.inject` services (`systemPrompt` and
 * `skills`) — so the doubles are small. Crucially, **the filesystem double is
 * backed by the real filesystem**: `stat` calls
 * `node:fs.statSync`. That is what makes `detect.test.ts` a genuine end-to-end
 * test of detection rather than a test of a mock — it walks real directories
 * built by `test/fixtures/build-fixtures.sh`, with real `.jj` and `.git`
 * entries created by real `jj` and `git`.
 *
 * `node:fs` here is deliberate and is not a violation of the `src/` invariant:
 * the invariant exists so the *plugin* cannot escape the sandbox, and a test
 * that did not touch the real disk could not verify anything.
 *
 * @module dsh-jujutsu/test-helpers
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

/** The fixture root the builder script uses by default. */
export const FIXTURES = "/tmp/dsh-jujutsu-fixtures";

/**
 * Every shape the published fixture root must contain.
 *
 * `test/global-setup.ts` publishes the root with an atomic rename, so anything
 * *it* writes is whole; this list is for a root left behind by the older,
 * non-atomic build. Checking `jj-colocated` alone would call an interrupted one
 * complete, and the rest of the suite would then read five fixtures that are not
 * there — the exact "present for the author, absent for everyone else" failure
 * `global-setup.ts` exists to prevent.
 */
const FIXTURE_SHAPES = [
  "plain-git/.git",
  "not-a-repo",
  "jj-native/.jj",
  "jj-colocated/.jj",
  "jj-secondary/primary/.jj",
  "jj-secondary/secondary/.jj",
  "jj-with-changes/.jj",
  "jj-nested/outer/sub/.jj",
] as const;

/**
 * Whether the fixture repositories are present and complete.
 *
 * They are built by `test/global-setup.ts` when `jj` is on PATH. When it is not,
 * the tests that need a real repository skip against this rather than failing
 * with a message that blames the guard.
 */
export function fixturesAvailable(): boolean {
  return FIXTURE_SHAPES.every((shape) => existsSync(join(FIXTURES, shape)));
}

/** The root's completeness, evaluated once per process. */
export const HAS_FIXTURES = fixturesAvailable();

/**
 * Whether `jj-hunk` is on PATH.
 *
 * The hunk bridge is one of the plugin's two headline features, and `jj-hunk`
 * ships only on crates.io — no prebuilt binary — so it is genuinely absent on a
 * clean runner. Tests that drive it say so rather than failing with
 * `exited 127: jj-hunk: not found`, which names the symptom and not the cause.
 */
export const HAS_JJ_HUNK = ((): boolean => {
  try {
    execFileSync("jj-hunk", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Whether `jj` is on PATH.
 *
 * `e2e.test.ts` builds its own repositories rather than using the fixtures, but
 * it drives the real binary — so without `jj` it fails on the first `execFileSync`
 * with an error that names neither the tool nor the reason.
 */
export const HAS_JJ = ((): boolean => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Whether this run demands that the real binaries were exercised.
 *
 * `release.yml` sets `DSH_JUJUTSU_REQUIRE_TOOLS=1` so a green run means `jj` and
 * `jj-hunk` actually ran. Without it, `describe.skipIf(!HAS_JJ)` turns a missing
 * binary into a *skip*, and a skip is not a failure — the release workflow ran
 * `pnpm run ci` without installing either binary, so every real-tool test
 * skipped and `verify` passed. A release would have shipped having tested
 * nothing (`test/global-setup.ts`).
 *
 * The fixture-gated suites are covered by `global-setup.ts`, which throws under
 * the same variable when `jj` or `git` is missing. `jj-hunk` is not: it ships
 * only on crates.io, so it is installed out of band, and the file that drives it
 * has to count for itself.
 */
export const REQUIRE_TOOLS = process.env.DSH_JUJUTSU_REQUIRE_TOOLS === "1";

/**
 * How many `it(` blocks a test file declares, counted the way `docs.test.ts`
 * counts them.
 *
 * Used to prove that a run executed every test the file declares, rather than
 * skipping some against a missing binary.
 */
export function declaredTests(fileUrl: string): number {
  return [...readFileSync(fileURLToPath(fileUrl), "utf8").matchAll(/^\s+it\(/gm)].length;
}

/** One recorded `ctx.on` registration. */
export interface Listener {
  readonly event: string;
  readonly handler: (...args: never[]) => unknown;
}

/** What the plugin registered with `ctx.systemPrompt`. */
export interface CapturedPrompt {
  readonly sections: {
    name: string;
    order: number;
    text: (context: unknown) => string;
  }[];
  readonly contexts: {
    name: string;
    order: number;
    text: (context: unknown) => string;
  }[];
}

/**
 * What the plugin registered with `ctx.skills`.
 *
 * `source: "bundled"` is the harness's own discriminator for a skill that ships
 * with the plugin rather than being read from a directory on disk; the panel and
 * the catalog both key on it.
 */
export interface RegisteredSkill {
  readonly name: string;
  readonly source: string;
  readonly description: string;
  readonly content: string;
}

/**
 * A `ctx.shell` double that runs commands **for real**.
 *
 * The plugin reaches `jj` and `jj-hunk` through `ctx.shell`, whose request is a
 * command *string* (`shell.ts` quotes each argument). This double honours that
 * contract by handing the string to a shell, so a test using it exercises the
 * plugin's argv construction, its quoting, and its output parsing against the
 * installed binaries rather than against a mock's idea of them.
 *
 * Nothing else about the plugin is stubbed when this is used: `hunk.ts` and the
 * `jj_*` tools run their real code paths.
 *
 * @param env - extra environment for every command, merged over `process.env`.
 *   `e2e.test.ts` passes its generated `JJ_CONFIG` this way rather than mutating
 *   `process.env`: a test file that edits global environment leaks into every
 *   other file vitest runs in the same worker, and the identity config is per
 *   repository, not per run.
 */
export function realShell(ctx: Context, env?: Readonly<Record<string, string | undefined>>): void {
  const shell = {
    resolve: (request: { command: string; workdir?: string }) => request,
    execute: async (spec: { command: string; workdir?: string }) => ({
      result: async () => {
        const { exec } = await import("node:child_process");
        return await new Promise((done) => {
          exec(
            spec.command,
            {
              cwd: spec.workdir,
              maxBuffer: 32 * 1024 * 1024,
              env: env === undefined ? process.env : { ...process.env, ...env },
            },
            (error, stdout, stderr) => {
              const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
              done({
                exitCode: code,
                signal: null,
                timedOut: false,
                stdout: { text: stdout, truncated: false },
                stderr: { text: stderr, truncated: false },
              });
            },
          );
        });
      },
    }),
  };
  (ctx as unknown as { shell: unknown }).shell = shell;
  const get = (ctx as unknown as { get: (n: string) => unknown }).get;
  (ctx as unknown as { get: (n: string) => unknown }).get = (name: string) =>
    name === "shell" ? shell : get.call(ctx, name);
}

export interface FakeHarness {
  readonly ctx: Context;
  readonly listeners: readonly Listener[];
  /** Every decision the registered `tools/pre-execute` listener produced. */
  readonly decisions: readonly PreToolDecision[];
  /**
   * Run one tool call through the registered pre-execute listener.
   *
   * Function-valued fields rather than methods, here and in the next two: they
   * are closures over this double's state, tests destructure them, and a method
   * declaration would make every extraction look like a lost receiver.
   */
  readonly preExecute: (exec: ToolExecution) => Promise<PreToolDecision>;
  /** Run one result through the registered post-execute listener. */
  readonly postExecute: (exec: ToolExecution, result: { isError?: boolean }) => Promise<unknown>;
  /** Register a session with the given id so `exec.agent.session.id` resolves. */
  readonly session: (id: string, cwd: string) => FakeSession;
  /** Everything the plugin registered with `ctx.systemPrompt`. */
  readonly prompt: CapturedPrompt;
  /** Everything the plugin registered with `ctx.skills`, in order. */
  readonly skills: readonly RegisteredSkill[];
  /** Every tool definition the plugin registered, in order. */
  readonly tools: readonly Record<string, unknown>[];
}

export interface FakeSession {
  readonly exec: (name: string, args: unknown) => ToolExecution;
}

/** The approval policy a fake harness reports. */
export type Policy = "ask" | "never" | undefined;

/**
 * Build a harness double.
 *
 * @param options.policy - what `approval.overrideOf(session)` returns.
 *   `undefined` means "no session override", so the deployment default applies.
 * @param options.defaultPolicy - what `approval.config.policy` reports.
 * @param options.skills - whether the harness has a `skills` service. `false`
 *   models a profile that mounted the plugin without one, where
 *   `ctx.inject(['skills'], …)` must simply never run its callback.
 */
export function fakeHarness(
  options: {
    policy?: Policy;
    defaultPolicy?: "ask" | "never";
    skills?: boolean;
  } = {},
): FakeHarness {
  const listeners: Listener[] = [];
  const prompt: CapturedPrompt = { sections: [], contexts: [] };
  const skills: RegisteredSkill[] = [];
  const tools: Record<string, unknown>[] = [];

  const fs = {
    async resolve(path: string) {
      return { targetKey: path };
    },
    async readText(target: { targetKey: string }) {
      return readFileSync(target.targetKey, "utf8");
    },
    async stat(target: { targetKey: string }) {
      try {
        const stats = statSync(target.targetKey);
        return {
          version: "v1",
          type: stats.isDirectory()
            ? ("directory" as const)
            : stats.isFile()
              ? ("file" as const)
              : ("other" as const),
        };
      } catch {
        return undefined;
      }
    },
  };

  const approval = {
    overrideOf: () => options.policy,
    config: { policy: options.defaultPolicy ?? "ask" },
  };

  const toolsRegistry = {
    register: (definition: unknown) => {
      tools.push(definition as Record<string, unknown>);
      return () => undefined;
    },
  };

  const skillsRegistry = {
    register: (skill: RegisteredSkill) => {
      skills.push(skill);
      return () => undefined;
    },
  };

  // A faithful enough `SystemPrompt` for the two registrations the plugin makes:
  // an order table and the two capture points.
  const systemPrompt = {
    getSectionOrder: (name: string) => (name === "TOOL_BASH" ? 1000 : 0),
    section: (entry: CapturedPrompt["sections"][number]) => {
      prompt.sections.push(entry);
      return () => undefined;
    },
    context: (entry: CapturedPrompt["contexts"][number]) => {
      prompt.contexts.push(entry);
      return () => undefined;
    },
  };

  const ctx = {
    // `ctx.tools` is a Cordis service accessor, not a `ctx.get('tools')` call.
    tools: toolsRegistry,
    get: (name: string) => {
      if (name === "fs") return fs;
      if (name === "approval") return approval;
      if (name === "tools") return toolsRegistry;
      if (name === "shell") return undefined;
      return undefined;
    },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      listeners.push({ event, handler });
      return () => undefined;
    },
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      // `ctx.inject` withholds the callback until **every** requested service is
      // present, and a service that never arrives means the callback never runs.
      // Mirroring that is what makes "no `skills` service" testable without a
      // try/catch: a plugin that assumed the service was there would throw while
      // registering, and this double would never have called it.
      const scope: Record<string, unknown> = { systemPrompt };
      if (options.skills !== false) scope.skills = skillsRegistry;
      if (deps.every((dep) => dep in scope)) callback(scope);
      return () => undefined;
    },
  } as unknown as Context;

  const find = (event: string) => listeners.find((l) => l.event === event);

  const session = (id: string, cwd: string): FakeSession => ({
    exec: (name, args) =>
      ({
        callId: `call-${id}-${name}`,
        name,
        arguments: args,
        agent: { session: { id, header: { cwd } } },
      }) as unknown as ToolExecution,
  });

  return {
    ctx,
    listeners,
    prompt,
    skills,
    tools,
    decisions: [],
    async preExecute(exec) {
      const listener = find("tools/pre-execute");
      if (listener === undefined) throw new Error("no pre-execute listener registered");
      const handler = listener.handler as unknown as (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ) => Promise<PreToolDecision>;
      return handler(exec, async () => ({ kind: "allow" }));
    },
    async postExecute(exec, result) {
      // Chain **every** post-execute listener, the way the real waterfall does.
      // Taking only the first would silently skip the explainer, because the
      // guard registers a cache-maintenance listener before it.
      const handlers = listeners
        .filter((entry) => entry.event === "tools/post-execute")
        .map(
          (entry) =>
            entry.handler as unknown as (
              exec: ToolExecution,
              result: { isError?: boolean },
              next: () => Promise<unknown>,
            ) => Promise<unknown>,
        );
      const run = async (index: number): Promise<unknown> => {
        const handler = handlers[index];
        if (handler === undefined) return { kind: "accept" };
        return handler(exec, result, () => run(index + 1));
      };
      return run(0);
    },
    session,
  };
}
