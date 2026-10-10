/**
 * Test doubles for the harness seams.
 *
 * The plugin reads exactly three things from the harness — `ctx.fs`, `ctx.on`,
 * and `ctx.get('approval')` — so the doubles are small. Crucially, **the
 * filesystem double is backed by the real filesystem**: `stat` calls
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

import { readFileSync, statSync } from "node:fs";

import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

/** The fixture root the builder script uses by default. */
export const FIXTURES = "/tmp/dsh-jujutsu-fixtures";

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

export interface FakeHarness {
  readonly ctx: Context;
  readonly listeners: readonly Listener[];
  /** Every decision the registered `tools/pre-execute` listener produced. */
  readonly decisions: readonly PreToolDecision[];
  /** Run one tool call through the registered pre-execute listener. */
  preExecute(exec: ToolExecution): Promise<PreToolDecision>;
  /** Run one result through the registered post-execute listener. */
  postExecute(exec: ToolExecution, result: { isError?: boolean }): Promise<unknown>;
  /** Register a session with the given id so `exec.agent.session.id` resolves. */
  session(id: string, cwd: string): FakeSession;
  /** Everything the plugin registered with `ctx.systemPrompt`. */
  readonly prompt: CapturedPrompt;
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
 */
export function fakeHarness(options: {
  policy?: Policy;
  defaultPolicy?: "ask" | "never";
} = {}): FakeHarness {
  const listeners: Listener[] = [];
  const prompt: CapturedPrompt = { sections: [], contexts: [] };
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
      if (!deps.includes("systemPrompt")) return () => undefined;
      // A faithful enough `SystemPrompt` for the two registrations the plugin
      // makes: an order table and the two capture points.
      callback({
        systemPrompt: {
          getSectionOrder: (name: string) => (name === "TOOL_BASH" ? 1000 : 0),
          section: (entry: CapturedPrompt["sections"][number]) => {
            prompt.sections.push(entry);
            return () => undefined;
          },
          context: (entry: CapturedPrompt["contexts"][number]) => {
            prompt.contexts.push(entry);
            return () => undefined;
          },
        },
      });
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
