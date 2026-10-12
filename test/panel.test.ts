/**
 * The admin panel's contract: with the schema, with the harness's components,
 * and with its own translations.
 *
 * The panel is hand-written JavaScript and the schema is TypeScript, so nothing
 * at build time connects them. These tests are that connection.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PANEL = readFileSync("client/panel.js", "utf8");
const CONFIG = readFileSync("src/config.ts", "utf8");
const PKG = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;

/** Field names declared in `Config`. */
function schemaFields(): Set<string> {
  const body = CONFIG.slice(CONFIG.indexOf("z.object({"));
  return new Set([...body.matchAll(/^  ([a-zA-Z]+): z\b/gm)].map((m) => m[1] ?? ""));
}

/** Load the bundle with stubbed modules and return its exports. */
function loadPanel(): Record<string, any> {
  let factory: ((require: (id: string) => unknown) => Record<string, any>) | undefined;
  const win = {
    __ModuleLoader__: {
      load: (m: { factory: never }) => {
        factory = m.factory;
      },
    },
  };
  new Function("window", PANEL)(win);
  if (factory === undefined) throw new Error("bundle did not register a factory");

  const stubs: Record<string, unknown> = {
    "@deepseek-ai/dsh-client-ui-primitives": {
      SettingsForm: "SettingsForm",
      SettingsValueField: "SettingsValueField",
      ConfigField: "ConfigField",
      DisclosureRow: "DisclosureRow",
      // Mirrors the real classes exactly, because the bug this guards against
      // was reading handlers off the wrong one. `SettingsFormShell` is state
      // only (`available`/`writable`/`dirty`/`invalid`/`saving`/`failed`) and
      // `SettingsFieldState` is `{ text, overridden, invalid }`; every verb
      // lives in `actions()`.
      SettingsFormModel: class {
        shell() {
          return {
            available: true, writable: true, dirty: false,
            invalid: false, saving: false, failed: false,
          };
        }
        field() {
          return { text: "x", overridden: false, invalid: false };
        }
        actions() {
          return { edit() {}, resetField() {}, save() {}, discard() {} };
        }
        bind(project: () => unknown) {
          // The real one republishes on scope and draft changes; a one-shot
          // render only needs the initial projection.
          return { subscribe: () => () => {}, getSnapshot: project };
        }
        dispose() {}
      },
      settingsTextField: (f: string) => ({
        field: f,
        format: (v: unknown) => String(v ?? ""),
        parse: (t: string) => ({ kind: "set", value: t }),
      }),
    },
    react: {
      createElement: (type: unknown, props: unknown, ...kids: unknown[]) => ({ type, props, kids }),
      useState: (initial: unknown) => [initial, () => {}],
      // The panel subscribes to a bound store. Calling `getSnapshot` is the
      // whole of what a one-shot render needs from this.
      useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
    },
  };
  return factory((id: string) => stubs[id]);
}

/** Reach the Panel component through `apply`'s own registration. */
function panelComponent() {
  const panel = loadPanel();
  let registered: ((p: unknown) => unknown) | undefined;
  let injected: Record<string, unknown> = {};
  panel.apply({
    effect: (fn: () => unknown) => fn(),
    locale: { register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, mutate: async () => {} }),
      whileServed: (_n: string[], fn: () => unknown) => {
        fn();
        return () => {};
      },
    },
    slots: {
      inject: (_n: string, fn: () => unknown) => {
        fn();
        return () => {};
      },
      register: (spec: { inject?: () => Record<string, unknown> }, c: (p: unknown) => unknown) => {
        injected = spec.inject?.() ?? {};
        registered = c;
        return () => {};
      },
    },
  });
  // `t` is what the slot supplies from `locale: NS`; a key-echoing stub proves
  // the panel asks for the right keys without needing the real dictionary.
  const t = (key: string) => key;
  return { Panel: (extra: Record<string, unknown>) => registered!({ ...injected, t, ...extra }), panel };
}

/** Collect `[type, props]` for every element, running function components. */
function elementsOf(node: unknown, out: [string, any][] = []): [string, any][] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) elementsOf(item, out);
    return out;
  }
  const n = node as { type?: unknown; props?: unknown; kids?: unknown[] };
  if (typeof n.type === "function") {
    elementsOf(n.type(n.props ?? {}), out);
    return out;
  }
  if (typeof n.type === "string") out.push([n.type, n.props ?? {}]);
  for (const kid of n.kids ?? []) elementsOf(kid, out);
  return out;
}

/** Collect every element type in a rendered tree, running function components. */
function typesOf(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) typesOf(item, out);
    return out;
  }
  const n = node as { type?: unknown; props?: unknown; kids?: unknown[] };
  if (typeof n.type === "function") {
    typesOf(n.type(n.props ?? {}), out);
    return out;
  }
  if (typeof n.type === "string") out.push(n.type);
  for (const kid of n.kids ?? []) typesOf(kid, out);
  return out;
}

describe("the panel covers the schema", () => {
  it("draws a control for every config field", () => {
    const missing = [...schemaFields()].filter((f) => !(f in loadPanel().FIELDS));
    expect(missing).toEqual([]);
  });

  it("draws no control for a field the schema does not have", () => {
    const extra = Object.keys(loadPanel().FIELDS).filter((f) => !schemaFields().has(f));
    expect(extra).toEqual([]);
  });

  it("groups every field exactly once", () => {
    const listed = loadPanel()
      .GROUPS.flatMap((g: { fields: string[] }) => g.fields);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(Object.keys(loadPanel().FIELDS)));
  });
});

describe("built-in components only", () => {
  it("renders every field through ConfigField", () => {
    const { Panel, panel } = panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    const controls = types.filter((x) => x === "ConfigField");
    expect(controls).toHaveLength(Object.keys(panel.FIELDS).length);
    for (const handRolled of ["Switch", "SegmentedControl", "SettingsValueField", "section", "h3", "input"]) {
      expect(types, handRolled).not.toContain(handRolled);
    }
  });

  it("groups fields with the built-in DisclosureRow", () => {
    const { Panel, panel } = panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    expect(types.filter((x) => x === "DisclosureRow")).toHaveLength(panel.GROUPS.length);
  });

  it("draws no inline styles", () => {
    expect(PANEL).not.toContain("style: {");
  });
});

describe("translations", () => {
  const { STRINGS } = loadPanel();

  it("has the same keys in every locale", () => {
    // A key in one locale and not another renders the key itself, which is
    // visible — but better to catch it here.
    const en = Object.keys(STRINGS.en).sort();
    for (const locale of Object.keys(STRINGS)) {
      expect(Object.keys(STRINGS[locale]).sort(), locale).toEqual(en);
    }
  });

  it("translates every string it declares", () => {
    for (const locale of Object.keys(STRINGS)) {
      for (const [key, value] of Object.entries(STRINGS[locale] as Record<string, string>)) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("resolves every group and field key", () => {
    const panel = loadPanel();
    const keys = [
      ...panel.GROUPS.flatMap((g: { titleKey: string; blurbKey: string }) => [g.titleKey, g.blurbKey]),
      ...Object.values(panel.FIELDS as Record<string, { labelKey: string; hintKey: string }>)
        .flatMap((f) => [f.labelKey, f.hintKey]),
    ];
    for (const locale of Object.keys(STRINGS)) {
      for (const key of keys) {
        expect(STRINGS[locale][key], `${locale}.${key}`).toBeTypeOf("string");
      }
    }
  });

  it("keeps the English hints identical to the schema descriptions", () => {
    // A panel that describes a setting differently from the setting's own
    // schema is worse than no panel. The host renders `config.ts`; this renders
    // the panel.
    const flat = CONFIG.replace(/\s+/g, " ");
    for (const [name, meta] of Object.entries(
      loadPanel().FIELDS as Record<string, { hintKey: string }>,
    )) {
      const hint = (STRINGS.en as Record<string, string>)[meta.hintKey] ?? "";
      expect(hint.length, name).toBeGreaterThan(20);
      expect(flat, name).toContain(hint.replace(/\s+/g, " ").slice(0, 60));
    }
  });
});

describe("the display metadata the host reads", () => {
  it("names the plugin in both locales", () => {
    for (const lang of ["en", "zh"]) {
      const meta = JSON.parse(readFileSync(`locale/${lang}.json`, "utf8")) as {
        meta: { title: string; description: string };
      };
      expect(meta.meta.title, lang).toBe("Jujutsu");
      expect(meta.meta.description.length, lang).toBeGreaterThan(40);
    }
  });

  it("declares the icon and ships it", () => {
    // `readPluginMeta` resolves `icon` relative to the manifest and caps it at
    // 256 KiB.
    expect(PKG.icon).toBe("./icon.svg");
    const svg = readFileSync("icon.svg", "utf8");
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(262_144);
  });

  it("exports the locale files, which the host resolves through `exports`", () => {
    // `readPluginMeta` reaches `locale/<lang>.json` via the exports-aware
    // resolver, so a missing entry fails with ERR_PACKAGE_PATH_NOT_EXPORTED and
    // the display name silently falls back to the package id. Measured: that is
    // exactly what happened before this entry existed. The icon needs no entry
    // — `iconOf` reads it straight off the manifest's directory.
    const exportsMap = PKG.exports as Record<string, unknown>;
    expect(Object.keys(exportsMap)).toContain("./locale/*.json");
  });

  it("ships the metadata files", () => {
    const files = PKG.files as string[];
    for (const entry of ["locale/*.json", "icon.svg", "lib", "client"]) {
      expect(files, entry).toContain(entry);
    }
  });
});

describe("the bundle loads as written", () => {
  it("wraps itself in the ModuleLoader factory", () => {
    expect(PANEL).toContain("window.__ModuleLoader__.load");
    expect(PANEL).toContain('id: "dsh-jujutsu"');
  });

  it("requires only what the client runtime provides", () => {
    const requires = [...PANEL.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(requires.sort()).toEqual([
      "@deepseek-ai/dsh-client-ui-primitives",
      "react",
    ]);
  });

  it("mounts on the bundle's own page, keyed by the package name", () => {
    expect(PANEL).toContain('"plugins.bundle.config"');
    expect(PANEL).toContain("key: NS");
    expect(PANEL).not.toContain('"plugins.row.config"');
    expect(PKG.name).toBe("dsh-jujutsu");
  });
});

describe("the handlers come from the right object", () => {
  it("passes callable handlers to every ConfigField", () => {
    // The bug this exists for: the panel read `onChange`/`onReset` off the
    // field STATE and `onSave`/`onDiscard` off the form SHELL. None of those
    // four exist, so all four were `undefined`, `ConfigField` threw on render,
    // and the slot retired the entry — leaving it on the ledger as an occupant
    // with `active: false` while the page drew nothing. Registration was never
    // evidence the panel worked.
    const { Panel } = panelComponent();
    const elements = elementsOf(Panel({ view: "page" }));
    const fields = elements.filter(([type]) => type === "ConfigField");
    expect(fields.length).toBeGreaterThan(0);
    for (const [, props] of fields) {
      expect(typeof props.onChange, "onChange").toBe("function");
      expect(typeof props.onReset, "onReset").toBe("function");
      expect(typeof props.disabled, "disabled").toBe("boolean");
      expect(typeof props.value, "value").toBe("string");
    }
    const forms = elements.filter(([type]) => type === "SettingsForm");
    expect(forms).toHaveLength(1);
    expect(typeof forms[0]![1].onSave, "onSave").toBe("function");
    expect(typeof forms[0]![1].onDiscard, "onDiscard").toBe("function");
    expect(forms[0]![1].state).toBeTypeOf("object");
  });

  it("renders without throwing", () => {
    // A throwing render is not a visible error: the slot swallows it and
    // abdicates the entry. Fail loudly here instead.
    const { Panel } = panelComponent();
    expect(() => elementsOf(Panel({ view: "page" }))).not.toThrow();
  });
});

describe("the client half is built, not hand-written", () => {
  it("is generated from TypeScript", () => {
    // It was hand-written JavaScript for three revisions, and every bug the
    // panel had was a type error tsc would have refused. The bundle is now
    // tsc output wrapped by scripts/build-client.mjs, so the source of truth is
    // src/client/panel.ts.
    expect(PANEL).toContain("GENERATED FILE — do not edit");
    expect(PANEL).toContain("src/client/panel.ts");
    const source = readFileSync("src/client/panel.ts", "utf8");
    expect(source).toContain("interface SettingsFieldState");
    expect(source).toContain("interface SettingsFormShell");
  });

  it("has a build that produces it", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("tsconfig.client.json");
    expect(pkg.scripts.build).toContain("build-client.mjs");
  });

  it("does not carry its own loader call in the module body", () => {
    // The wrapper owns `__ModuleLoader__.load`; the emitted body must not, or
    // the bundle would register twice.
    const count = (PANEL.match(/__ModuleLoader__/g) ?? []).length;
    expect(count).toBe(1);
  });
});
