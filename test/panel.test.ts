/**
 * The admin panel's contract with the schema.
 *
 * The panel is hand-written JavaScript and the schema is TypeScript, so nothing
 * at build time connects them. This test is that connection: every field the
 * panel draws must exist in `Config`, and every hint it shows must be the
 * schema's own description. A panel that describes a setting differently from
 * the setting's own schema is worse than no panel.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PANEL = readFileSync("client/panel.js", "utf8");
const CONFIG = readFileSync("src/config.ts", "utf8");

/** Field names declared in `Config`. */
function schemaFields(): Set<string> {
  const body = CONFIG.slice(CONFIG.indexOf("z.object({"));
  return new Set([...body.matchAll(/^  ([a-zA-Z]+): z\b/gm)].map((m) => m[1] ?? ""));
}

/** Field names the panel draws, from `FIELDS`. */
function panelFields(): Set<string> {
  const body = PANEL.slice(PANEL.indexOf("var FIELDS = {"));
  return new Set([...body.matchAll(/^ {6}([a-zA-Z]+): \{/gm)].map((m) => m[1] ?? ""));
}

describe("the panel covers the schema", () => {
  it("draws a control for every config field", () => {
    const missing = [...schemaFields()].filter((f) => !panelFields().has(f));
    expect(missing).toEqual([]);
  });

  it("draws no control for a field the schema does not have", () => {
    const extra = [...panelFields()].filter((f) => !schemaFields().has(f));
    expect(extra).toEqual([]);
  });

  it("groups every field exactly once", () => {
    const listed = [...PANEL.matchAll(/fields: \[([^\]]*)\]/g)]
      .flatMap((m) => (m[1] ?? "").split(","))
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(panelFields());
  });
});

describe("the panel's copy matches the schema", () => {
  it("uses each field's own description as its hint", () => {
    // The descriptions are long single strings in `config.ts`; pull them out and
    // require each to appear verbatim in the panel.
    const hints = [...PANEL.matchAll(/hint:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => (m[1] ?? "").replace(/\\"/g, '"'),
    );
    expect(hints.length).toBeGreaterThanOrEqual(panelFields().size);
    for (const hint of hints) {
      expect(CONFIG.replace(/\s+/g, " ")).toContain(hint.replace(/\s+/g, " ").slice(0, 60));
    }
  });
});

describe("the client bundle is loadable as written", () => {
  it("wraps itself in the ModuleLoader factory the web client expects", () => {
    expect(PANEL).toContain("window.__ModuleLoader__.load");
    expect(PANEL).toContain('id: "dsh-jujutsu"');
    expect(PANEL).toContain("factory: factory");
  });

  it("requires only what the client runtime provides", () => {
    const requires = [...PANEL.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(requires.sort()).toEqual([
      "@deepseek-ai/dsh-client-ui-primitives",
      "react",
    ]);
  });

  it("declares the same namespace as the host half", () => {
    // The Plugins page keys the row by this string; if the two halves disagree
    // the form is served a namespace nothing writes.
    expect(PANEL).toContain('var NS = "dsh-jujutsu"');
    const index = readFileSync("src/index.ts", "utf8");
    expect(index).toContain('name = "dsh-jujutsu"');
  });
});

describe("the panel factory actually runs", () => {
  /** Load the bundle with stubbed modules and return its exports. */
  async function loadPanel(): Promise<Record<string, any>> {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("client/panel.js", "utf8");
    let factory: ((require: (id: string) => unknown) => Record<string, any>) | undefined;
    const sandbox = { window: { __ModuleLoader__: { load: (m: { factory: never }) => { factory = m.factory; } } } };
    // The bundle is a script, not a module: run it with `window` in scope.
    new Function("window", source)(sandbox.window);
    if (factory === undefined) throw new Error("bundle did not register a factory");

    const stubs: Record<string, unknown> = {
      "@deepseek-ai/dsh-client-ui-primitives": {
        SettingsForm: "SettingsForm",
        SettingsValueField: "SettingsValueField",
        ConfigField: "ConfigField",
        DisclosureRow: "DisclosureRow",
        SettingsFormModel: class {
          shell() {
            return { onSave() {}, onDiscard() {} };
          }
          field() {
            return {
              text: "x", overridden: false, invalid: false, disabled: false,
              onEdit() {}, onReset() {},
            };
          }
        },
        settingsTextField: (f: string) => ({
          field: f,
          format: (v: unknown) => String(v ?? ""),
          parse: (t: string) => ({ kind: "set", value: t }),
        }),
      },
      react: { createElement: (...a: unknown[]) => ({ type: a[0], props: a[1] }) },
    };
    return factory((id: string) => stubs[id]);
  }

  it("registers a factory under the plugin's id", async () => {
    const panel = await loadPanel();
    expect(panel.NS).toBe("dsh-jujutsu");
    expect(panel.inject).toEqual(["slots", "locale", "configForms"]);
  });

  it("builds one spec per config field", async () => {
    const panel = await loadPanel();
    expect(panel.buildSpecs()).toHaveLength(panelFields().size);
  });

  it("blocks a save on a value the field does not accept", async () => {
    // `parse` returning undefined is what blocks the save rather than
    // discarding the edit silently — the contract the form model documents.
    const panel = await loadPanel();
    expect(panel.booleanField("enabled").parse("true")).toEqual({ kind: "set", value: true });
    expect(panel.booleanField("enabled").parse("maybe")).toBeUndefined();
    expect(panel.enumField("guard", ["deny", "off"]).parse("deny")).toEqual({
      kind: "set", value: "deny",
    });
    expect(panel.enumField("guard", ["deny", "off"]).parse("allow")).toBeUndefined();
  });

  it("round-trips a stored value through format", async () => {
    const panel = await loadPanel();
    expect(panel.booleanField("enabled").format(false)).toBe("false");
    expect(panel.booleanField("enabled").format(undefined)).toBe("");
    expect(panel.enumField("guard", ["deny", "off"]).format("off")).toBe("off");
  });
});



describe("the row id must equal the settings namespace", () => {
  /**
   * A coupling that is invisible from either file alone.
   *
   * The slot is keyed `<package name>#<row id>`, but the page resolves the
   * form it passes to the entry with `formFor(openRow.rowId)` — and `formFor`
   * returns `undefined` unless some configuration namespace equals that id.
   * So the row id must be the settings namespace, or the panel is rendered
   * with no `form` at all.
   *
   * It holds today only because both happen to be `dsh-jujutsu`.
   */
  it("uses the same string for the patch row id and the namespace", () => {
    const patch = readFileSync("cordis.patch.yml", "utf8");
    const rowId = /-\s*id:\s*([a-z-]+)/.exec(patch)?.[1];
    expect(rowId).toBe("dsh-jujutsu");
    expect(PANEL).toContain(`var NS = "${rowId}"`);
  });

  it("mounts on the bundle's own page, keyed by the package name", () => {
    // `plugins.bundle.config` renders on the plugin's page between its
    // description and its rows. `plugins.row.config` would put it behind a
    // Configure control on one row instead.
    expect(PANEL).toContain('"plugins.bundle.config"');
    expect(PANEL).toContain("key: NS");
    expect(PANEL).not.toContain('"plugins.row.config"');
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string };
    expect(pkg.name).toBe("dsh-jujutsu");
  });
});

describe("each field renders the control its type deserves", () => {
  /** Load the bundle and reach the Panel through apply's registration. */
  async function panelComponent() {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("client/panel.js", "utf8");
    let factory: ((require: (id: string) => unknown) => Record<string, any>) | undefined;
    const win = { __ModuleLoader__: { load: (m: { factory: never }) => { factory = m.factory; } } };
    new Function("window", source)(win);
    if (factory === undefined) throw new Error("no factory");

    const fields: Record<string, { text: string }> = {};
    const stubs: Record<string, unknown> = {
      "@deepseek-ai/dsh-client-ui-primitives": {
        SettingsForm: "SettingsForm",
        SettingsValueField: "SettingsValueField",
        ConfigField: "ConfigField",
        DisclosureRow: "DisclosureRow",
        SettingsFormModel: class {
          shell() { return { onSave() {}, onDiscard() {} }; }
          field(name: string) {
            fields[name] ??= { text: "" };
            return {
              ...fields[name], overridden: false, invalid: false, disabled: false,
              onEdit() {}, onReset() {},
            };
          }
        },
        settingsTextField: (f: string) => ({ field: f, format: String, parse: (x: string) => ({ kind: "set", value: x }) }),
      },
      react: {
        createElement: (type: unknown, props: unknown, ...kids: unknown[]) => ({ type, props, kids }),
        useState: (initial: unknown) => [initial, () => {}],
      },
    };
    const panel = factory((id: string) => stubs[id]);

    let registered: ((p: unknown) => unknown) | undefined;
    let injected: Record<string, unknown> = {};
    panel.apply({
      effect: (fn: () => unknown) => fn(),
      locale: { register: () => () => {} },
      configForms: {
        get: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, mutate: async () => {} }),
        whileServed: (_n: string[], fn: () => unknown) => { fn(); return () => {}; },
      },
      slots: {
        inject: (_n: string, fn: () => unknown) => { fn(); return () => {}; },
        register: (spec: { inject?: () => Record<string, unknown> }, c: (p: unknown) => unknown) => {
          // The page renders the component with whatever `inject` supplies —
          // the model, in this plugin's case. Calling it here is what makes the
          // test exercise the same props the real page would pass.
          injected = spec.inject?.() ?? {};
          registered = c;
          return () => {};
        },
      },
    });
    return { Panel: (extra: Record<string, unknown>) => registered!({ ...injected, ...extra }), panel };
  }

  /** Collect every element type in a rendered tree. */
  function typesOf(node: unknown, out: string[] = []): string[] {
    if (node === null || typeof node !== "object") return out;
    // Children arrive as arrays as often as single nodes: `createElement(type,
    // props, blocks)` gives one array child, and the group maps give arrays too.
    if (Array.isArray(node)) {
      for (const item of node) typesOf(item, out);
      return out;
    }
    const n = node as { type?: unknown; props?: unknown; kids?: unknown[] };
    // A function component's own output only exists once it runs, so run it —
    // otherwise the walk stops at `Group` and never sees the fields inside.
    if (typeof n.type === "function") {
      typesOf(n.type(n.props ?? {}), out);
      return out;
    }
    if (typeof n.type === "string") out.push(n.type);
    for (const kid of n.kids ?? []) typesOf(kid, out);
    return out;
  }

  it("renders every field through the built-in ConfigField", async () => {
    // One code path for all three kinds: `ConfigField` picks the control from
    // `choices` (empty -> text, finite -> a choice control). The panel draws no
    // label, input or reset of its own.
    const { Panel, panel } = await panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    const controls = types.filter((x) => x === "ConfigField");
    expect(controls).toHaveLength(Object.keys(panel.FIELDS).length);
    // No hand-rolled control components.
    expect(types).not.toContain("Switch");
    expect(types).not.toContain("SegmentedControl");
    expect(types).not.toContain("SettingsValueField");
  });

  it("gives each field the choices its kind needs", async () => {
    // `choices` is the whole control selection: empty means a text input, a
    // finite list means a choice control, and a boolean is just two choices.
    const { panel } = await panelComponent();
    for (const [name, meta] of Object.entries(panel.FIELDS as Record<string, any>)) {
      const choices = panel.choicesOf(meta) as string[];
      // Text fields get an empty list (a text input); every other kind gets a
      // finite list (a choice control). That list is the entire selection.
      if (meta.kind === "text") expect(choices, name).toEqual([]);
      else expect(choices.length, name).toBeGreaterThan(1);
    }
    expect(panel.choicesOf(panel.FIELDS.enabled)).toEqual(["true", "false"]);
    expect(panel.FIELDS.jjPath.kind).toBe("text");
  });

  it("groups fields with the built-in DisclosureRow", async () => {
    // The harness's own disclosure header, one per group. It is controlled, so
    // the open state lives in the panel rather than in the component.
    const { Panel, panel } = await panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    const groups = types.filter((x) => x === "DisclosureRow");
    expect(groups).toHaveLength((panel.GROUPS as unknown[]).length);
    // And no hand-rolled section chrome.
    expect(types).not.toContain("section");
    expect(types).not.toContain("h3");
  });

  it("declares choices as plain strings, which is what ConfigField takes", async () => {
    const { panel } = await panelComponent();
    for (const [name, meta] of Object.entries(panel.FIELDS as Record<string, any>)) {
      for (const c of panel.choicesOf(meta) as string[]) {
        expect(typeof c, name).toBe("string");
      }
    }
  });
});
