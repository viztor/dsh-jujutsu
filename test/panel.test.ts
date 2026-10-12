/**
 * The admin panel's contract: with the schema, with the harness's components,
 * and with its own translations.
 *
 * The panel is hand-written JavaScript and the schema is TypeScript, so nothing
 * at build time connects them. These tests are that connection.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PANEL = readFileSync("lib/client.js", "utf8");
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
      Switch: "Switch",
      SegmentedControl: "SegmentedControl",
      Tag: "Tag",
      Button: "Button",
      DisclosureRow: "DisclosureRow",
      // Mirrors the real classes exactly, because the bug this guards against
      // was reading handlers off the wrong one. `SettingsFormShell` is state
      // only (`available`/`writable`/`dirty`/`invalid`/`saving`/`failed`) and
      // `SettingsFieldState` is `{ text, overridden, invalid }`; every verb
      // lives in `actions()`.
      SettingsFormModel: class {
        shell() {
          return {
            available: true,
            writable: true,
            dirty: false,
            invalid: false,
            saving: false,
            failed: false,
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
  return {
    Panel: (extra: Record<string, unknown>) => registered!({ ...injected, t, ...extra }),
    panel,
  };
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
    const listed = loadPanel().GROUPS.flatMap((g: { fields: string[] }) => g.fields);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(Object.keys(loadPanel().FIELDS)));
  });
});

describe("built-in components only", () => {
  it("gives each field the control its kind deserves", () => {
    // A boolean shown as a text box reading `true` -- with a hint explaining
    // that `true` is what you type -- is worse than no control at all. Switch
    // for booleans, SegmentedControl for enums, SettingsValueField for text.
    const { Panel, panel } = panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    const fields = Object.values(panel.FIELDS as Record<string, { kind: string }>);
    const byKind = (kind: string) => fields.filter((f) => f.kind === kind).length;

    expect(types.filter((x) => x === "SettingsValueField")).toHaveLength(byKind("text"));
    expect(types.filter((x) => x === "Switch")).toHaveLength(byKind("boolean"));
    expect(types.filter((x) => x === "SegmentedControl")).toHaveLength(byKind("enum"));

    // And no hand-rolled control anywhere.
    for (const handRolled of ["ConfigField", "section", "h3", "input", "select"]) {
      expect(types, handRolled).not.toContain(handRolled);
    }
  });

  it("groups fields with the built-in DisclosureRow", () => {
    const { Panel, panel } = panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    expect(types.filter((x) => x === "DisclosureRow")).toHaveLength(panel.GROUPS.length);
  });

  it("styles itself only with the harness's theme tokens", () => {
    // A client bundle has no stylesheet of its own -- the primitives ship CSS
    // modules and a plugin cannot -- so a card's own chrome must style itself
    // inline. What matters is that every value is a theme token rather than a
    // hardcoded colour, so the shell follows light/dark and any restyle.
    const styles = [...PANEL.matchAll(/style:\s*\{/g)];
    expect(styles.length).toBeGreaterThan(0);
    const colours = [...PANEL.matchAll(/color:\s*"([^"]+)"/g)].map((m) => m[1] as string);
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      expect(colour, colour).toContain("var(--dsw-");
    }
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
      ...panel.GROUPS.flatMap((g: { titleKey: string; blurbKey: string }) => [
        g.titleKey,
        g.blurbKey,
      ]),
      ...Object.values(
        panel.FIELDS as Record<string, { labelKey: string; hintKey: string }>,
      ).flatMap((f) => [f.labelKey, f.hintKey]),
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
    // `lib` carries both halves now: the host bundle and the client bundle the
    // harness's route serves as `${package}/client.js`.
    for (const entry of ["locale/*.json", "icon.svg", "lib"]) {
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
    expect(requires.sort()).toEqual(["@deepseek-ai/dsh-client-ui-primitives", "react"]);
  });

  it("mounts on the bundle's own page, keyed by the package name", () => {
    expect(PANEL).toContain('"plugins.bundle.config"');
    expect(PANEL).toContain("key: NS");
    expect(PANEL).not.toContain('"plugins.row.config"');
    expect(PKG.name).toBe("dsh-jujutsu");
  });
});

describe("the handlers come from the right object", () => {
  it("passes callable handlers to every SettingsValueField", () => {
    // The bug this exists for: the panel read `onChange`/`onReset` off the
    // field STATE and `onSave`/`onDiscard` off the form SHELL. None of those
    // four exist, so all four were `undefined`, `ConfigField` threw on render,
    // and the slot retired the entry — leaving it on the ledger as an occupant
    // with `active: false` while the page drew nothing. Registration was never
    // evidence the panel worked.
    const { Panel } = panelComponent();
    const elements = elementsOf(Panel({ view: "page" }));
    const fields = elements.filter(([type]) => type === "SettingsValueField");
    expect(fields.length).toBeGreaterThan(0);
    for (const [, props] of fields) {
      expect(typeof props.onEdit, "onEdit").toBe("function");
      expect(typeof props.onReset, "onReset").toBe("function");
      expect(typeof props.disabled, "disabled").toBe("boolean");
      expect(typeof props.text, "text").toBe("string");
      expect(typeof props.id, "id").toBe("string");
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
    // Built by `vp pack`, not hand-written. The loader wrapper is the bundler's
    // banner/footer now, so the proof is that the artifact exists and carries
    // exactly one registration.
    expect(PANEL).toContain("window.__ModuleLoader__.load");
    const source = readFileSync("src/client/panel.ts", "utf8");
    expect(source).toContain("interface SettingsFieldState");
    expect(source).toContain("interface SettingsFormShell");
  });

  it("has a build that produces it", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      exports: Record<string, { default: string }>;
    };
    expect(pkg.scripts.build).toContain("vp pack");
    expect(pkg.scripts.build).toContain("name-client-bundle");
    // The route serves `${package}/client.js` and accepts only
    // `/^client\..*\.js$/`, so the artifact must end in `.js` even though the
    // bundler emits `.cjs` for a `type: module` package.
    expect(pkg.exports["./client"]?.default).toBe("./lib/client.js");
  });

  it("does not carry its own loader call in the module body", () => {
    // The wrapper owns `__ModuleLoader__.load`; the emitted body must not, or
    // the bundle would register twice.
    const count = (PANEL.match(/__ModuleLoader__/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe("the client entry declares its services", () => {
  it("exports `inject`, without which the entry cannot activate", async () => {
    // Cordis reads `inject` off the client entry. Without it the entry is
    // injected nothing, `apply` throws on the first service it reaches, and the
    // failure is NOT local: the entry does not activate, the web boot reports
    // "1 entry did not activate", and the whole page fails to load.
    //
    // A TypeScript rewrite dropped this export. Nothing typechecked it, because
    // the export IS the declaration. The app broke on the next reload.
    const { inject } = loadPanel();
    expect(Array.isArray(inject)).toBe(true);
    expect(inject).toEqual(["slots", "locale", "configForms"]);
  });

  it("names only services `apply` actually reaches for", () => {
    // An injected service that is never used is a dependency the entry waits on
    // for nothing; a service used but not injected is a crash at activation.
    const source = readFileSync("src/client/panel.ts", "utf8");
    const declared = [...source.matchAll(/ctx\.(\w+)/g)].map((m) => m[1]);
    const used = [...new Set(declared)].filter((name) =>
      ["slots", "locale", "configForms"].includes(name as string),
    );
    expect(new Set(used)).toEqual(new Set(["slots", "locale", "configForms"]));
  });
});

describe("the panel uses only what the primitives export", () => {
  /**
   * The names `@deepseek-ai/dsh-client-ui-primitives` exports from its index,
   * transcribed from the harness's `src/index.ts`.
   *
   * `ConfigField` is NOT among them. It exists as a file — it belongs to the
   * *generated* forms — so `require(primitives).ConfigField` is `undefined`, and
   * `createElement(undefined)` throws "Element type is invalid". The slot
   * answers that by retiring the entry, so the page shows no form and says
   * nothing. That is what this panel did for four revisions.
   */
  const PRIMITIVE_EXPORTS = new Set([
    "Button",
    "Checkbox",
    "DisclosureRow",
    "SettingsForm",
    "SettingsFormModel",
    "SettingsSecretField",
    "SettingsValueField",
    "Switch",
    "SegmentedControl",
    "Tag",
    "settingsNumberField",
    "settingsTextField",
  ]);

  it("requires only names the primitives actually export", () => {
    const source = readFileSync("src/client/panel.ts", "utf8");
    const block = source.slice(source.indexOf("const REQUIRED = ["));
    const required = [...block.slice(0, block.indexOf("]")).matchAll(/"([A-Za-z]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(required.length).toBeGreaterThan(0);
    const missing = required.filter((name) => !PRIMITIVE_EXPORTS.has(name));
    expect(missing).toEqual([]);
  });

  it("does not reach for ConfigField, which is not exported", () => {
    // Named explicitly, because it is the one that looks right and is not.
    const source = readFileSync("src/client/panel.ts", "utf8");
    expect(source).not.toContain("primitives.ConfigField");
  });
});

describe("each control gets the props it requires", () => {
  it("gives SegmentedControl at least two labelled options", () => {
    // Its contract says "at least two": a one-segment tablist is not a control,
    // and a segment with no label renders an empty tab. The labels are the
    // localized value strings, not the config tokens.
    const { Panel } = panelComponent();
    const segmented = elementsOf(Panel({ view: "page" })).filter(
      ([type]) => type === "SegmentedControl",
    );
    expect(segmented.length).toBeGreaterThan(0);
    for (const [, props] of segmented) {
      expect(typeof props.id, "id").toBe("string");
      expect(typeof props.label, "label").toBe("string");
      expect(props.label.length).toBeGreaterThan(0);
      expect(Array.isArray(props.options)).toBe(true);
      expect(props.options.length).toBeGreaterThanOrEqual(2);
      for (const option of props.options) {
        expect(typeof option.value, "value").toBe("string");
        expect(typeof option.label, "label").toBe("string");
        // A raw config token would mean the i18n lookup missed.
        expect(option.label).not.toBe(option.value);
      }
      expect(typeof props.onChange, "onChange").toBe("function");
    }
  });

  it("gives Switch a boolean and an accessible name", () => {
    const { Panel } = panelComponent();
    const switches = elementsOf(Panel({ view: "page" })).filter(([type]) => type === "Switch");
    expect(switches.length).toBeGreaterThan(0);
    for (const [, props] of switches) {
      expect(typeof props.checked, "checked").toBe("boolean");
      expect(typeof props.onChange, "onChange").toBe("function");
      expect(typeof props.label, "label").toBe("string");
      expect(props.label.length).toBeGreaterThan(0);
    }
  });

  it("gives every field an id its label can point at", () => {
    // `SettingsValueField` and `SegmentedControl` both take an `id`, and both
    // wire it to a `<label htmlFor>`. A missing or duplicated id leaves the
    // label pointing at nothing, which is invisible until someone uses a screen
    // reader or clicks the text.
    const { Panel } = panelComponent();
    const withIds = elementsOf(Panel({ view: "page" })).filter(
      ([type]) => type === "SettingsValueField" || type === "SegmentedControl",
    );
    const ids = withIds.map(([, props]) => props.id as string);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
