import { readFileSync } from "node:fs";

/**
 * The tool surface.
 *
 * These tests are about the *shape* of the registration — names, that the
 * registry is actually reached, and that the guard rails inside the hunk tools
 * fire. They deliberately do not run `jj`: the command construction is covered
 * by `hunk.ts`'s pre-checks here and by the live verification recorded in
 * `src/README.md`.
 */

import { describe, expect, it } from "vitest";

import { applyTools, TOOL_NAMES } from "../src/tools.ts";
import { resolveSettings } from "../src/settings.ts";
import { fakeHarness } from "./helpers.ts";

function registered() {
  const harness = fakeHarness();
  applyTools(harness.ctx, resolveSettings({}));
  return harness.tools.map((tool) => String(tool.name));
}

describe("the eleven tools", () => {
  it("registers every documented name, exactly once", () => {
    const names = registered();
    expect(new Set(names).size).toBe(names.length);
    for (const expected of TOOL_NAMES) {
      expect(names, expected).toContain(expected);
    }
  });

  it("registers the documented count", () => {
    // docs/18 says eleven: 4 reads, 5 mutations, 2 hunk. An earlier draft said
    // "ten" while listing eleven, which a subagent caught.
    expect(TOOL_NAMES).toHaveLength(11);
    expect(registered()).toHaveLength(11);
  });

  it("gives every tool a description that names its jj fact", () => {
    const harness = fakeHarness();
    applyTools(harness.ctx, resolveSettings({}));
    for (const tool of harness.tools) {
      expect(String(tool.description ?? "").length, String(tool.name)).toBeGreaterThan(40);
    }
  });

  it("requires the registry before it registers anything", () => {
    // Without `ctx.tools` there is nowhere to put them, and registering into a
    // void would be worse than doing nothing.
    const harness = fakeHarness();
    const ctx = harness.ctx as unknown as {
      tools?: unknown;
      get: (name: string) => unknown;
    };
    // Both accessors are the same service, so a test that removes one has to
    // remove the other — otherwise it asserts nothing.
    delete ctx.tools;
    const realGet = ctx.get.bind(ctx);
    ctx.get = (name: string) => (name === "tools" ? undefined : realGet(name));
    applyTools(harness.ctx, resolveSettings({}));
    expect(harness.tools).toHaveLength(0);
  });
});

describe("every definition survives the real defineTool", () => {
  it("is accepted by the registry's own constructor", async () => {
    // The gap this closes: `applyTools` swallows a registration failure so one
    // bad tool cannot take down the plugin load. That is right at runtime and
    // wrong at build time — a definition the registry refuses would otherwise
    // ship silently, registering nothing.
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    const { buildToolDefinitions } = await import("../src/tools.ts");
    const harness = fakeHarness();
    const definitions = buildToolDefinitions(harness.ctx, resolveSettings({}));
    expect(definitions).toHaveLength(11);
    for (const definition of definitions) {
      const name = String(definition.name);
      expect(() => defineTool(definition as never), name).not.toThrow();
    }
  });
});

describe("jj bookmark flags — verified against jj 0.46.0", () => {
  it("uses -r for create and set", async () => {
    const { bookmarkArgv } = await import("../src/tools.ts");
    expect(bookmarkArgv("create", "feat", "@")).toEqual(["bookmark", "create", "feat", "-r", "@"]);
    expect(bookmarkArgv("set", "feat", "@-")).toEqual(["bookmark", "set", "feat", "-r", "@-"]);
  });

  it("uses --to for move, which has no -r", () => {
    // `jj bookmark move` takes -t/--to. Passing -r is a hard error, not a no-op.
    return import("../src/tools.ts").then(({ bookmarkArgv }) => {
      expect(bookmarkArgv("move", "feat", "@")).toEqual(["bookmark", "move", "feat", "--to", "@"]);
    });
  });

  it("omits the revision flag for delete, forget and rename", async () => {
    const { bookmarkArgv } = await import("../src/tools.ts");
    for (const action of ["delete", "forget", "rename"]) {
      expect(bookmarkArgv(action, "feat", "@"), action).toEqual(["bookmark", action, "feat"]);
    }
  });

  it("passes no name when none was given", async () => {
    const { bookmarkArgv } = await import("../src/tools.ts");
    expect(bookmarkArgv("list")).toEqual(["bookmark", "list"]);
  });
});

describe("jj output parsing — real jj 0.46.0 shapes", () => {
  // The objects below are real 0.46.0 output; the **newlines between them are
  // not**. `jj log --no-graph -T 'json(self)'` writes its objects back to back
  // with no separator at all, so this fixture used to describe a shape jj never
  // produces — which is exactly why the suite passed while `jj_log`, `jj_status`
  // and `jj_op_log` were broken in production. The plugin's templates now end
  // with `++ "\n"`, and the test below asserts that they do.
  //
  // Note there is no `conflict` key: that is why jj_status queries it separately.
  const REAL_NDJSON = [
    '{"commit_id":"3f36cebc222466bf08f46ecf9cb3245dcfb1fa42","parents":["e0cb8ce0f145457cfb9e91f85b3ccaa0741d2b73"],"change_id":"nqmnskmmvnttwxkzqmttkqpvtnzrroqx","description":"","author":{"name":"dsh-jujutsu fixture","email":"fixture@example.invalid","timestamp":"2026-10-10T16:22:34+08:00"}}',
    '{"commit_id":"e0cb8ce0f145457cfb9e91f85b3ccaa0741d2b73","parents":[],"change_id":"pzylsvzkqxlz","description":"base"}',
  ].join("\n");

  it("parses newline-delimited JSON into an array", async () => {
    const { parseJsonLines } = await import("../src/tools.ts");
    const parsed = parseJsonLines(REAL_NDJSON, "jj log");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values).toHaveLength(2);
    expect((parsed.values[0] as { change_id: string }).change_id).toBe(
      "nqmnskmmvnttwxkzqmttkqpvtnzrroqx",
    );
  });

  it("confirms json(self) carries no conflict key", async () => {
    // The gap this closes: jj_status would otherwise report a conflicted working
    // copy as if it were clean, and `jj new` propagates a conflict rather than
    // escaping it.
    const { parseJsonLines } = await import("../src/tools.ts");
    const parsed = parseJsonLines(REAL_NDJSON, "jj log");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.values[0] as object)).not.toContain("conflict");
  });

  it("ignores blank lines and trailing newlines", async () => {
    const { parseJsonLines } = await import("../src/tools.ts");
    const parsed = parseJsonLines(`${REAL_NDJSON}\n\n`, "jj log");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.values).toHaveLength(2);
  });

  it("returns a typed error rather than half-parsing", async () => {
    // A truncated stream must be a hard error, never a best-effort parse.
    const { parseJsonLines } = await import("../src/tools.ts");
    const parsed = parseJsonLines('{"commit_id":"abc"}\n{"commit_id":', "jj log");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect((parsed.error as { code: string }).code).toBe("JJ_OUTPUT_NOT_JSON");
  });
});

describe("jj bookmark rename takes two positional names", () => {
  it("passes both old and new", async () => {
    // `jj bookmark rename <OLD> <NEW>` — one name is a usage error.
    const { bookmarkArgv } = await import("../src/tools.ts");
    expect(bookmarkArgv("rename", "old", undefined, "new")).toEqual([
      "bookmark",
      "rename",
      "old",
      "new",
    ]);
  });

  it("does not append a stray new name for other actions", async () => {
    const { bookmarkArgv } = await import("../src/tools.ts");
    expect(bookmarkArgv("delete", "feat", undefined, "ignored")).toEqual([
      "bookmark",
      "delete",
      "feat",
    ]);
  });
});

describe("jj diff --summary parsing", () => {
  it("splits status from path", async () => {
    const { parseSummary } = await import("../src/tools.ts");
    expect(parseSummary("M src/server.js\nA new.txt\nD gone.txt")).toEqual([
      { status: "M", path: "src/server.js" },
      { status: "A", path: "new.txt" },
      { status: "D", path: "gone.txt" },
    ]);
  });

  it("keeps a rename brace form intact rather than inventing structure", async () => {
    // jj renders a rename as `R {old => new}`; that is a display format, so the
    // remainder is kept whole.
    const { parseSummary } = await import("../src/tools.ts");
    expect(parseSummary("R {old.txt => new.txt}")).toEqual([
      { status: "R", path: "{old.txt => new.txt}" },
    ]);
  });

  it("returns an empty list for no changes", async () => {
    const { parseSummary } = await import("../src/tools.ts");
    expect(parseSummary("")).toEqual([]);
  });
});

describe("identity parsing — the empty-identity trap", () => {
  it("accepts a complete identity", async () => {
    const { parseIdentity } = await import("../src/tools.ts");
    expect(parseIdentity('user.name = "Someone"\nuser.email = "s@example.invalid"')).toBe(true);
  });

  it("rejects the real unset output", async () => {
    // Captured from `jj config list user` on 0.46.0 with nothing configured.
    // It exits 0, so the exit code cannot be used as the signal.
    const { parseIdentity } = await import("../src/tools.ts");
    expect(parseIdentity("Warning: No matching config key for: user")).toBe(false);
  });

  it("requires BOTH name and email", async () => {
    const { parseIdentity } = await import("../src/tools.ts");
    expect(parseIdentity('user.name = "Someone"')).toBe(false);
    expect(parseIdentity('user.email = "s@example.invalid"')).toBe(false);
  });

  it("rejects an empty value", async () => {
    const { parseIdentity } = await import("../src/tools.ts");
    expect(parseIdentity('user.name = ""\nuser.email = "s@example.invalid"')).toBe(false);
  });
});

describe("the push trap is surfaced where it can still be avoided", () => {
  it("warns on jj_new that an undescribed change cannot be pushed", async () => {
    // Measured: `jj git push --bookmark x` refuses with
    //   "Won't push commit … since it has no description"
    // The failure is recoverable (jj names the commit) but predictable, and
    // `jj_new` is the last point where the model can avoid it.
    const { buildToolDefinitions } = await import("../src/tools.ts");
    const defs = buildToolDefinitions(fakeHarness().ctx, resolveSettings({}));
    const def = defs.find((d) => d.name === "jj_new") as
      | { description: string; parameters: Record<string, { description?: string }> }
      | undefined;
    expect(def).toBeDefined();
    expect(def!.description).toContain("refuses to push");
    expect(def!.parameters.message?.description ?? "").toContain("cannot be pushed");
  });
});

describe("every multi-revision template delimits its own output", () => {
  it("ends the json(self) template with a newline", async () => {
    // jj adds no separator between template results, so the template must. This
    // is the regression guard for a bug no unit test could see: the parser was
    // fed well-formed newline-delimited input by hand, while the command that
    // produced it never emitted a newline. Measured against 0.46.0:
    //   jj log --no-graph -T 'json(self)' -r '@|@-' | wc -l   ->  0
    //   jj log --no-graph -T 'json(self) ++ "\n"' -r '@|@-' | wc -l  ->  2
    const source = readFileSync("src/tools.ts", "utf8");
    // Only the templates that can emit more than one object need this. A
    // single-value template (`-T conflict`) emits one line and needs nothing.
    const templates = [...source.matchAll(/"-T",\s*('([^']*)'|"([^"]*)")/g)]
      .map((m) => m[2] ?? m[3] ?? "")
      .filter((template) => template.includes("json("));
    expect(templates.length).toBeGreaterThanOrEqual(3);
    // The SOURCE text is checked, not an evaluated string, so the expected
    // value needs the two characters the file actually holds: `String.raw`
    // keeps them literal instead of collapsing them to one backslash.
    // Built from a char code so the escaping is unambiguous: the source file
    // holds TWO backslashes, because the template needs `\\n` for jj to
    // receive a real newline escape.
    const bs = String.fromCharCode(92);
    const expected = `++ "${bs}${bs}n"`;
    for (const template of templates) {
      expect(template, template).toContain(expected);
    }
  });
});
