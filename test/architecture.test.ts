/**
 * The module graph, as an invariant rather than a habit.
 *
 * `src/` is 21 modules with a deliberate shape: a small set of leaves that know
 * nothing about the plugin (`parse`, `invocation`, `messages`), a middle that
 * reads the world (`detect`, `marker`, `paths`, `shell`), and a top that decides
 * (`guard`, `tools`, `context`, `index`). Nothing enforces that shape except
 * care, and care is not a gate.
 *
 * It was already broken once and nothing noticed. `invocation.ts` — the ported
 * resolver engine — imported its own `Invocation` type from `parse.ts`, which is
 * the facade *over* `invocation.ts`. That is an import cycle, and it survived
 * because the edge was `import type`: erased at compile time, harmless at
 * runtime, invisible to every other check.
 *
 * These tests are cheap, and they fail with the offending edge named.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

/** Every `src/*.ts` module, and the `src/*.ts` modules it imports. */
function graph(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    const deps = new Set<string>();
    for (const match of source.matchAll(/from "\.\/([a-z-]+)\.ts"/g)) {
      if (match[1] !== undefined) deps.add(match[1]);
    }
    out[file.replace(/\.ts$/, "")] = [...deps].sort();
  }
  return out;
}

describe("the module graph has no cycles", () => {
  it("is acyclic, counting type-only edges", () => {
    // Type-only edges are included on purpose. They are the ones that hide: the
    // compiler erases them, so a cycle built from them cannot fail at runtime and
    // cannot be seen in a stack trace. The fix is the same either way — the type
    // belongs to the module that produces the value.
    const g = graph();
    const found = new Map<string, string>();
    const walk = (node: string, stack: string[], seen: Set<string>): void => {
      if (stack.includes(node)) {
        // One cycle is reachable from every node on it, and in both directions,
        // so the raw walk reports the same loop once per rotation. Keyed by the
        // *distinct* members, each cycle is named exactly once — keying on the
        // sorted walk is not enough, because a rotation repeats a different node.
        const cycle = [...stack.slice(stack.indexOf(node)), node];
        found.set([...new Set(cycle)].sort().join(" -> "), cycle.join(" -> "));
        return;
      }
      if (seen.has(node)) return;
      seen.add(node);
      for (const dep of g[node] ?? []) walk(dep, [...stack, node], seen);
    };
    for (const node of Object.keys(g)) walk(node, [], new Set());

    const distinct = [...found.values()];
    expect(distinct).toEqual([]);
  });
});

describe("every module is reachable", () => {
  it("is imported, directly or transitively, from index.ts", () => {
    // An orphan is a module that compiles, lints, and may even be tested, while
    // nothing ships it. Reachability from the entry point is the only structural
    // definition of "this is part of the plugin".
    const g = graph();
    const seen = new Set<string>();
    const walk = (node: string): void => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const dep of g[node] ?? []) walk(dep);
    };
    walk("index");

    const orphans = Object.keys(g).filter((name) => !seen.has(name));
    expect(orphans).toEqual([]);
  });
});

describe("the leaves stay leaves", () => {
  it("has no module importing the plugin's entry point", () => {
    // `index.ts` mounts everything. Anything importing it is either a cycle
    // waiting to happen or a module that has quietly become a second entry point.
    const g = graph();
    const importers = Object.entries(g)
      .filter(([, deps]) => deps.includes("index"))
      .map(([name]) => name);
    expect(importers).toEqual([]);
  });

  it("keeps the resolver free of policy", () => {
    // `parse.ts` and `invocation.ts` answer "what does this command run". They
    // must not know what the answer is *for*: no settings, no messages, no
    // decisions. That separation is what lets the 64-command corpus test the
    // resolver without a harness.
    const g = graph();
    const forbidden = ["guard", "messages", "settings", "verbs", "index", "tools"];
    for (const leaf of ["parse", "invocation"]) {
      const violations = (g[leaf] ?? []).filter((dep) => forbidden.includes(dep));
      expect(violations, `${leaf} imports`).toEqual([]);
    }
  });
});
