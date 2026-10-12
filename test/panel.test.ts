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
/**
 * The hooks called during one render, in order.
 *
 * A real renderer would enforce React's rules for us, but there is no renderer
 * here — no `react-dom`, and this session cannot install one. So the stub does
 * the one check that matters: hooks must be called in the same order on every
 * render. A hook behind a condition throws at runtime in React, which the slot
 * answers by retiring the entry, which is how this panel went blank before.
 */
const hookLog: string[] = [];

function loadPanel(
  fieldState: { text?: string; overridden?: boolean; invalid?: boolean } = {},
): Record<string, any> {
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
          return {
            text: fieldState.text ?? "x",
            overridden: fieldState.overridden ?? false,
            invalid: fieldState.invalid ?? false,
          };
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
      useState: (initial: unknown) => {
        hookLog.push("useState");
        return [initial, () => {}];
      },
      // The panel subscribes to a bound store. Calling `getSnapshot` is the
      // whole of what a one-shot render needs from this.
      useSyncExternalStore: (_sub: unknown, get: () => unknown) => {
        hookLog.push("useSyncExternalStore");
        return get();
      },
    },
  };
  return factory((id: string) => stubs[id]);
}

/** Reach the Panel component through `apply`'s own registration. */
function panelComponent(
  fieldState: { text?: string; overridden?: boolean; invalid?: boolean } = {},
) {
  const panel = loadPanel(fieldState);
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

/** Every string a rendered tree contains, joined. */
function textOf(node: unknown, out: string[] = []): string {
  if (typeof node === "string") {
    out.push(node);
    return out.join(" ");
  }
  if (node === null || typeof node !== "object") return out.join(" ");
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out);
    return out.join(" ");
  }
  const n = node as { type?: unknown; props?: unknown; kids?: unknown[] };
  if (typeof n.type === "function") {
    textOf(n.type(n.props ?? {}), out);
    return out.join(" ");
  }
  for (const kid of n.kids ?? []) textOf(kid, out);
  return out.join(" ");
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
  it("draws every field the panel exposes", () => {
    // The panel is deliberately a SUBSET of `Config`. The executable paths are
    // advanced: someone who needs them is editing a config file, and putting
    // them on the page would ask every other reader to decide about them. They
    // stay settable -- `Config` still declares them -- just not drawn.
    const missing = [...schemaFields()].filter((f) => !(f in loadPanel().FIELDS));
    expect(missing).toEqual(["jjPath", "jjHunkPath", "hunkInstall"]);
  });

  it("keeps the config-file-only fields settable", () => {
    // Not drawn is not the same as not supported. If these left `Config`, a
    // custom install could no longer point at its own jj.
    const schema = readFileSync("src/config.ts", "utf8");
    for (const field of ["jjPath", "jjHunkPath", "hunkInstall"]) {
      expect(schema, field).toContain(`${field}: z`);
    }
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

    // No field is `text`: the executable paths moved to the config file, and
    // the panel draws booleans and enums only.
    expect(byKind("text")).toBe(0);
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
      // `blurbKey` is optional: three groups had one that restated their own
      // heading, and a line that fills space makes the two that inform look
      // like boilerplate too.
      ...panel.GROUPS.flatMap((g: { titleKey: string; blurbKey?: string }) =>
        g.blurbKey === undefined ? [g.titleKey] : [g.titleKey, g.blurbKey],
      ),
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
  it("gives every control a callable handler", () => {
    // The bug this exists for: the panel read `onChange`/`onReset` off the field
    // STATE and `onSave`/`onDiscard` off the form SHELL. None of those four
    // exist, so all four were `undefined`, the control threw on render, and the
    // slot retired the entry -- leaving it on the ledger with `active: false`
    // while the page drew nothing. Registration was never evidence it worked.
    const { Panel } = panelComponent();
    const controls = elementsOf(Panel({ view: "page" })).filter(
      ([type]) => type === "Switch" || type === "SegmentedControl",
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const [type, props] of controls) {
      expect(typeof props.onChange, `${type}.onChange`).toBe("function");
      expect(typeof props.disabled, `${type}.disabled`).toBe("boolean");
    }
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

describe("hooks are called unconditionally, in a stable order", () => {
  it("calls the same hooks in the same order on every render", () => {
    const { Panel } = panelComponent();

    hookLog.length = 0;
    elementsOf(Panel({ view: "page" }));
    const first = [...hookLog];

    hookLog.length = 0;
    elementsOf(Panel({ view: "page" }));
    const second = [...hookLog];

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it("calls both of the hooks the panel relies on", () => {
    // Named rather than counted, so replacing one with the other is visible.
    const { Panel } = panelComponent();
    hookLog.length = 0;
    elementsOf(Panel({ view: "page" }));
    expect(hookLog).toContain("useSyncExternalStore");
    expect(hookLog).toContain("useState");
  });
});

describe("a draft the field rejects, and one the user overrode", () => {
  it("says a rejected draft is rejected, in the only place it can", () => {
    // Reachable without touching the panel: a config file edited by hand can
    // hold a value the field's spec refuses.
    //
    // Neither control can carry the state itself -- `Switch` and
    // `SegmentedControl` have no `invalid` prop; only `SettingsValueField` does,
    // and the panel no longer draws one. So the message line is the whole of the
    // signal, which is why the shell owns it rather than the control.
    const { Panel } = panelComponent({ invalid: true });
    const text = textOf(Panel({ view: "page" }));
    expect(text).toContain("invalid");
    expect(text).not.toContain("Hint");
  });

  it("shows the hint, not the invalid copy, for a good draft", () => {
    const { Panel } = panelComponent();
    const text = textOf(Panel({ view: "page" }));
    expect(text).not.toContain("invalid");
  });

  it("offers a reset once a value is overridden", () => {
    // The shell shows an override badge and a reset only when there is something
    // to reset; showing them always would put a control on every field that does
    // nothing for most of them.
    const { Panel } = panelComponent({ overridden: true });
    const types = typesOf(Panel({ view: "page" }));
    expect(types).toContain("Tag");
    expect(types).toContain("Button");
  });

  it("shows neither when the value is neither", () => {
    const { Panel } = panelComponent();
    const types = typesOf(Panel({ view: "page" }));
    expect(types).not.toContain("Tag");
    expect(types).not.toContain("Button");
  });
});

describe("two settings on the same scale read the same way round", () => {
  it("orders the shared choices identically", () => {
    // Caught by looking at the page: read-only Git showed deny|ask|allow and
    // writing Git showed ask|deny|allow. Same three values, same meaning, two
    // orders -- so the two controls could not be compared at a glance, which is
    // the only thing a segmented control is for.
    const { FIELDS } = loadPanel();
    const enums = Object.entries(FIELDS as Record<string, { choices?: string[] }>)
      .filter(([, meta]) => meta.choices !== undefined)
      .map(([name, meta]) => [name, meta.choices as string[]] as const);

    const shared = enums.filter(([, choices]) => choices.length === 3);
    expect(shared.length).toBeGreaterThan(1);
    const [first] = shared;
    for (const [name, choices] of shared) {
      expect(choices, `${name} vs ${first?.[0]}`).toEqual(first?.[1]);
    }
  });
});

describe("the read-only hint answers how read-only is decided", () => {
  it("names every always-read-only verb", () => {
    // The question the two settings raise first is which commands each covers.
    // A few examples with an ellipsis does not answer it, so the hint names the
    // whole classification -- and it has to stay in step with verbs.ts, which
    // this asserts against the real sets rather than a copy of them.
    const { STRINGS } = loadPanel();
    const hint = STRINGS.en.readOnlyGitHint as string;
    const verbs = readFileSync("src/verbs.ts", "utf8");
    const always = verbs
      .split("const ALWAYS_READ_ONLY: ReadonlySet<string> = new Set([")[1]
      ?.split("])")[0]
      ?.match(/"[a-z-]+"/g)
      ?.map((v) => v.replaceAll('"', ""));
    expect(always?.length).toBeGreaterThan(0);
    for (const verb of always ?? []) {
      expect(hint, verb).toContain(verb);
    }
  });

  it("names every verb whose read-only-ness depends on its form", () => {
    const { STRINGS } = loadPanel();
    const hint = STRINGS.en.readOnlyGitHint as string;
    const messages = readFileSync("src/messages.ts", "utf8");
    const conditional = messages
      .split("export const READ_ONLY_VERBS: ReadonlySet<string> = new Set([")[1]
      ?.split("])")[0]
      ?.match(/"[a-z-]+"/g)
      ?.map((v) => v.replaceAll('"', ""));
    expect(conditional?.length).toBeGreaterThan(0);
    for (const verb of conditional ?? []) {
      expect(hint, verb).toContain(verb);
    }
  });
});

describe("a two-state setting is a boolean, not a two-option enum", () => {
  it("draws no enum with fewer than three choices", () => {
    // Caught by looking at the page: Guard rendered as a segmented control
    // offering "Deny" and "Off" -- two states presented as if they were choices
    // of equal weight, when the setting is on or off. A two-option enum is a
    // boolean wearing the wrong control, and it reads as a decision the user has
    // to make rather than a switch they flip.
    const { FIELDS } = loadPanel();
    const tooSmall = Object.entries(FIELDS as Record<string, { choices?: string[] }>)
      .filter(([, meta]) => meta.choices !== undefined && meta.choices.length < 3)
      .map(([name]) => name);
    expect(tooSmall).toEqual([]);
  });

  it("declares guard as a boolean in the schema", () => {
    // The panel could be right and the schema wrong, or the reverse. This is the
    // other half: `guard` is `z.boolean()`, not an enum of deny/off.
    const schema = readFileSync("src/config.ts", "utf8");
    expect(schema).toMatch(/^ {2}guard: z\n?\s*\.boolean\(\)/m);
    expect(schema).not.toContain('z.const("off")');
  });

  it("reads guard as a boolean in both places that check it", () => {
    // `=== "off"` on a boolean is always false, so the guard would never be
    // inert and the setting would silently do nothing.
    for (const file of ["src/guard.ts", "src/explain.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain('settings.guard === "off"');
      expect(source, file).toContain("if (!settings.guard) return;");
    }
  });
});

describe("a hint talks about settings the way the user sees them", () => {
  it("names no raw schema key", () => {
    // Caught by reading the page: `preferJj`'s hint ended "Only used when
    // alertUninitialised is on" — the field's name in the config file, offered to
    // someone looking at a form whose label for it is "Mention missing version
    // control". The Chinese hint already used the label; only the English one had
    // the key.
    //
    // The tell is camelCase. A key with an uppercase letter in it is never an
    // ordinary English word, so its appearance in user-facing copy is always the
    // leak — which is why `guard` and `bypass` are excluded rather than listed.
    const schema = readFileSync("src/config.ts", "utf8");
    const keys = [...schema.matchAll(/^ {2}([a-zA-Z]+): z\b/gm)]
      .map((m) => m[1])
      .filter((key): key is string => key !== undefined && /[A-Z]/.test(key));
    expect(keys.length).toBeGreaterThan(0);

    const { STRINGS } = loadPanel();
    const offenders: string[] = [];
    for (const [locale, table] of Object.entries(
      STRINGS as Record<string, Record<string, string>>,
    )) {
      for (const [key, text] of Object.entries(table)) {
        if (!key.endsWith("Hint") || typeof text !== "string") continue;
        for (const schemaKey of keys) {
          if (text.includes(schemaKey)) offenders.push(`${locale}.${key} names ${schemaKey}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every locale string is reachable", () => {
  it("has no string nothing can render", () => {
    // Six had accumulated: the Binaries group's title and blurb after the group
    // moved to the config file, the `hunkInstall` choices, `Off` after Guard
    // became a boolean, and an "Inherited" badge never wired to anything. Each
    // was a real string for a real feature that had moved or gone.
    //
    // A dead string is not free: it is translated, reviewed, and read by whoever
    // next edits this file, who has to work out whether something is broken or
    // the string is simply unused.
    const source = readFileSync("src/client/panel.ts", "utf8");
    const { STRINGS } = loadPanel();
    const english = STRINGS.en as Record<string, string>;
    const defined = Object.keys(english).filter((key) => typeof english[key] === "string");

    const used = new Set<string>();
    for (const match of source.matchAll(/t\("([a-zA-Z]+)"\)/g)) used.add(match[1]!);
    for (const match of source.matchAll(/(?:labelKey|hintKey|titleKey|blurbKey): "([a-zA-Z]+)"/g)) {
      used.add(match[1]!);
    }
    // Enum labels resolve through `valueX` for each value a drawn field offers.
    const offered = new Set<string>();
    for (const match of source.matchAll(/choices: \[([^\]]+)\]/g)) {
      for (const value of match[1]!.matchAll(/"([a-z]+)"/g)) offered.add(value[1]!);
    }
    for (const value of offered) {
      used.add(`value${value.charAt(0).toUpperCase()}${value.slice(1)}`);
    }

    const dead = defined.filter((key) => !used.has(key)).sort();
    expect(dead).toEqual([]);
  });

  it("defines every key in both locales", () => {
    const { STRINGS } = loadPanel();
    const en = Object.keys(STRINGS.en as Record<string, string>).sort();
    const zh = Object.keys(STRINGS.zh as Record<string, string>).sort();
    expect(zh).toEqual(en);
  });
});

describe("every toggle says what Off does", () => {
  it("names the off state in its hint", () => {
    // A switch asks one question: what happens if I turn this off? Four of the
    // five answered it and `rememberBypass` did not — its hint described only the
    // on behaviour, leaving the reader to infer that the opposite of "stop
    // asking" is "keep asking", which is true but is the reader's work, not the
    // copy's.
    //
    // The panel shows the label and the hint and nothing else, so the hint is the
    // whole of the explanation a user gets.
    const { FIELDS, STRINGS } = loadPanel();
    const english = STRINGS.en as Record<string, string>;
    const missing: string[] = [];
    for (const [name, meta] of Object.entries(
      FIELDS as Record<string, { kind: string; hintKey: string }>,
    )) {
      if (meta.kind !== "boolean") continue;
      const hint = english[meta.hintKey] ?? "";
      if (!/\boff\b/i.test(hint)) missing.push(`${name} (${meta.hintKey})`);
    }
    expect(missing).toEqual([]);
  });

  it("names the off state in the config description too", () => {
    // The same sentence ships in the schema, which is what a host that skips the
    // panel renders. Drift between the two is caught by another test; this one
    // checks the schema has the sentence at all.
    const schema = readFileSync("src/config.ts", "utf8");
    const missing: string[] = [];
    for (const match of schema.matchAll(
      /^ {2}([a-zA-Z]+): z\n?\s*\.boolean\(\)[\s\S]*?\.description\(\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm,
    )) {
      if (!/\boff\b/i.test(match[2] ?? "")) missing.push(match[1] ?? "");
    }
    expect(missing).toEqual([]);
  });
});
