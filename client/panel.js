/**
 * `dsh-jujutsu` admin panel — the client half of the bundle.
 *
 * ## Why this file has to exist
 *
 * The harness **never reads a plugin's `Config` schema** when drawing the
 * Plugins page. It renders a form only when a client bundle contributes a slot
 * to it, so a package with a perfectly declared schema and no client half has
 * **no form at all** — and it degrades quietly rather than saying so. The host
 * half of this panel is `src/config.ts`; this is the other half.
 *
 * ## Built-in components only
 *
 * Every control is a harness primitive: `SettingsForm` for the frame,
 * `SettingsFormModel` for the drafts, and **`ConfigField`** for each field.
 * Nothing here draws its own label, input, reset or validation message —
 * `ConfigField` owns all of that, which is what keeps the panel looking like the
 * rest of the settings surface and surviving a restyle.
 *
 * `ConfigField` is driven by `value: string` plus `choices`:
 *
 * - **no `choices`** → a text input (a path),
 * - **`choices`** → a finite control (an enum, and `["true","false"]` for a
 *   boolean).
 *
 * So the field *kind* decides the control, and the panel never reaches for
 * `Switch` or `SegmentedControl` directly.
 *
 * ## Where it is mounted
 *
 * `plugins.bundle.config`, keyed by the **package name** — the bundle's own
 * page, between its description and its rows. Not `plugins.row.config`: that one
 * puts the configuration behind a Configure control on a single row, which is
 * right for a bundle declaring several rows with different settings. This bundle
 * declares one row and one configuration, so the configuration belongs on the
 * plugin's own page.
 *
 * `plugins.bundle.config` is also simpler by contract: it renders `view: 'page'`
 * **only**, so there is no `summary` branch to get wrong.
 *
 * ## Why it is hand-written JavaScript
 *
 * The web client loads a client bundle as a *script* through
 * `window.__ModuleLoader__.load`, so it must already be JavaScript in the CJS
 * factory format below. Producing that normally needs a bundler; this file is
 * written directly in the output format, which keeps the plugin free of one at
 * the cost of `React.createElement` instead of JSX.
 *
 * @module dsh-jujutsu/client/panel
 */

(function () {
  var factory = function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var react = require("react");

    var h = react.createElement;

    /** The settings namespace. Must equal the host half's exported `name`. */
    var NS = "dsh-jujutsu";

    /** Client services this page needs. */
    exports.inject = ["slots", "locale", "configForms"];
    exports.NS = NS;

    /**
     * Every field, grouped the way a user thinks about them rather than the
     * order `Config` declares them.
     */
    var GROUPS = [
      {
        id: "guard",
        title: "Guard",
        blurb:
          "What happens when the model reaches for Git inside a Jujutsu workspace.",
        fields: ["guard", "readOnlyGit", "bypass", "rememberBypass"],
      },
      {
        id: "init",
        title: "When there is no repository",
        blurb:
          "A directory with neither .jj nor .git has no history at all. The plugin can say so.",
        fields: ["alertUninitialised", "preferJj"],
      },
      {
        id: "prompt",
        title: "Teaching",
        blurb: "What the model is told about version control here.",
        fields: ["injectContext", "teachSkill"],
      },
      {
        id: "binaries",
        title: "Binaries",
        blurb: "Where jj and jj-hunk are found.",
        fields: ["jjPath", "jjHunkPath", "hunkInstall"],
      },
      {
        id: "master",
        title: "Master switch",
        blurb: "Turns the whole plugin off, guard included.",
        fields: ["enabled"],
      },
    ];

    /**
     * Field metadata: the accepted choices and the label.
     *
     * `choices` is what `ConfigField` renders as a finite control; an empty list
     * means a text input. The `hint` strings are the `Config` field descriptions
     * verbatim, kept in step by a test that reads both files.
     */
    var FIELDS = {
      enabled: {
        kind: "boolean",
        label: "Enabled",
        hint: "Master switch. Off unregisters everything: no guard, no tools, no prompt injection.",
      },
      guard: {
        kind: "enum",
        label: "Guard",
        choices: ["deny", "off"],
        hint: "deny refuses Git commands inside a Jujutsu workspace. off leaves the guard mounted but inert — useful to watch what it would have caught.",
      },
      readOnlyGit: {
        kind: "enum",
        label: "Read-only Git",
        choices: ["deny", "ask", "allow"],
        hint: "What to do with Git commands that only read (status, log, diff, show, blame). ask prompts; allow is for users who want the model to inspect Git directly. Mutating forms are never covered by this setting.",
      },
      bypass: {
        kind: "enum",
        label: "Writing Git",
        choices: ["ask", "deny", "allow"],
        hint: "What to do with Git commands that write (commit, push, checkout, rebase). ask requests a one-call approval; deny never asks; allow disables the guard for these.",
      },
      rememberBypass: {
        kind: "boolean",
        label: "Remember approvals",
        hint: "After you approve one Git command, stop asking about that same verb for the rest of the session. In memory only — it does not survive a restart.",
      },
      alertUninitialised: {
        kind: "boolean",
        label: "Mention missing version control",
        hint: "When a directory has no version control at all, tell the model so it can offer to initialise one. Off means the plugin stays silent outside a repository.",
      },
      preferJj: {
        kind: "boolean",
        label: "Prefer Jujutsu",
        hint: "Which to suggest when initialising: jj git init (colocated, Git tooling still works) or plain git init. Only used when alertUninitialised is on.",
      },
      injectContext: {
        kind: "boolean",
        label: "Explain Jujutsu in the prompt",
        hint: "Tell the model, in its system prompt, that version control here is Jujutsu. Off means the guard still refuses Git but the model is not told why.",
      },
      teachSkill: {
        kind: "boolean",
        label: "Offer the jj manual",
        hint: "Offer the jj manual as an on-demand skill. Token-neutral; off only means the model has less to read when it needs depth.",
      },
      jjPath: {
        kind: "text",
        label: "jj executable",
        hint: "The jj executable. Change this when jj is not on PATH, or to pin a specific build.",
      },
      jjHunkPath: {
        kind: "text",
        label: "jj-hunk executable",
        hint: "The jj-hunk executable. Hunk-level split and squash need it; without it those tools report unavailable rather than failing.",
      },
      hunkInstall: {
        kind: "enum",
        label: "When jj-hunk is missing",
        choices: ["ask", "never", "auto"],
        hint: "What to do when jj-hunk is missing. ask offers a pinned cargo install; never only reports; auto installs without asking.",
      },
    };

    /** The English dictionary. */
    var en = {
      title: "Jujutsu",
      description:
        "Makes the harness jj-native: Git is refused inside a Jujutsu workspace and the model is given the jj command instead.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The host did not accept the save.",
      unavailable:
        "This plugin is not currently mounted, so its settings cannot be edited.",
      readOnly: "This deployment stores settings read-only.",
      reset: "Reset to default",
      inherited: "Inherited",
      invalid: "Not a value this field accepts",
    };

    /** The choices `ConfigField` renders for a boolean. */
    var BOOLEAN_CHOICES = ["true", "false"];

    /** The choices for one field: an empty list means a text input. */
    function choicesOf(meta) {
      if (meta.kind === "boolean") return BOOLEAN_CHOICES;
      if (meta.kind === "enum") return meta.choices;
      return [];
    }

    /**
     * A boolean field, staged as text.
     *
     * The primitives ship text and number specs only, so this is the same
     * contract written here: `format` renders the stored value, `parse` returns
     * the write or `undefined` to block the save.
     */
    function booleanField(field) {
      return {
        field: field,
        format: function (value) {
          return typeof value === "boolean" ? String(value) : "";
        },
        parse: function (text) {
          var t = String(text).trim().toLowerCase();
          if (t === "true") return { kind: "set", value: true };
          if (t === "false") return { kind: "set", value: false };
          return undefined;
        },
      };
    }

    /** An enum field, staged as text, blocking anything outside its choices. */
    function enumField(field, choices) {
      return {
        field: field,
        format: function (value) {
          return typeof value === "string" ? value : "";
        },
        parse: function (text) {
          var t = String(text).trim();
          return choices.indexOf(t) === -1 ? undefined : { kind: "set", value: t };
        },
      };
    }

    /** Build every spec from `FIELDS`, so the two cannot disagree. */
    function buildSpecs() {
      return Object.keys(FIELDS).map(function (name) {
        var meta = FIELDS[name];
        if (meta.kind === "boolean") return booleanField(name);
        if (meta.kind === "enum") return enumField(name, meta.choices);
        return primitives.settingsTextField(name);
      });
    }

    /**
     * One field, rendered by `ConfigField`.
     *
     * The component owns the label, the control, the reset affordance and the
     * validation message; this function only maps the form model's per-field
     * state onto its props. `choices` is what selects the control, so a boolean
     * and an enum are one code path.
     */
    function control(model, name) {
      var meta = FIELDS[name];
      var state = model.field(name);
      return h(primitives.ConfigField, {
        key: name,
        label: meta.label,
        value: state.text,
        secret: false,
        choices: choicesOf(meta),
        disabled: state.disabled,
        overridden: state.overridden,
        invalid: state.invalid,
        labels: {
          reset: en.reset,
          inherited: en.inherited,
          invalid: en.invalid,
        },
        onChange: state.onEdit,
        onReset: state.onReset,
      });
    }

    /**
     * One collapsible group of fields.
     *
     * `DisclosureRow` is the harness's own disclosure header and is
     * **controlled** — it takes `open` and `onToggle` and holds no state — so
     * the open/closed state lives here. Groups start open: a settings page
     * whose fields are all hidden on arrival makes the user click to discover
     * what is configurable.
     */
    function Group(props) {
      var pair = react.useState(true);
      var open = pair[0];
      var setOpen = pair[1];
      return h(
        primitives.DisclosureRow,
        {
          icon: null,
          title: props.group.title,
          open: open,
          expandable: true,
          onToggle: function () {
            setOpen(!open);
          },
          expandOnRowClick: true,
        },
        h("p", { key: "blurb" }, props.group.blurb),
        props.group.fields.map(function (name) {
          return control(props.model, name);
        }),
      );
    }

    /** The panel: the form frame, then one disclosure per group. */
    function Panel(props) {
      var model = props.model;
      var shell = model.shell();
      var blocks = GROUPS.map(function (group) {
        return h(Group, { key: group.id, group: group, model: model });
      });
      return h(
        primitives.SettingsForm,
        {
          labels: {
            save: en.save,
            saving: en.saving,
            saveFailed: en.saveFailed,
            unavailable: en.unavailable,
            readOnly: en.readOnly,
          },
          state: shell,
          onSave: shell.onSave,
          onDiscard: shell.onDiscard,
        },
        blocks,
      );
    }

    /** Register the panel. */
    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, { en: en });
        } catch (error) {
          return undefined;
        }
      }, "dsh-jujutsu: dictionaries");

      // `configForms.get(namespace)` returns the full `ConfigForm` —
      // `{ getSnapshot, subscribe, mutate }` — which is exactly the scope
      // `SettingsFormModel` takes.
      var scope = ctx.configForms.get(NS);
      var model = new primitives.SettingsFormModel(scope, buildSpecs(), []);

      ctx.effect(function () {
        var stop = ctx.configForms.whileServed([NS], function () {
          // The bundle's own configuration, keyed by the package name. It
          // renders on the plugin's page between the description and the rows.
          var dispose = ctx.slots.inject("plugins.bundle.config", function () {
            return ctx.slots.register(
              {
                name: "plugins.bundle.config",
                key: NS,
                locale: NS,
                inject: function () {
                  return { model: model };
                },
              },
              Panel,
            );
          });
          return function () {
            if (typeof dispose === "function") dispose();
          };
        });
        return function () {
          if (typeof stop === "function") stop();
        };
      }, "dsh-jujutsu: panel");
    }

    exports.apply = apply;
    exports.FIELDS = FIELDS;
    exports.GROUPS = GROUPS;
    exports.Panel = Panel;
    exports.booleanField = booleanField;
    exports.enumField = enumField;
    exports.buildSpecs = buildSpecs;
    exports.choicesOf = choicesOf;
    exports.en = en;

    return module.exports;
  };

  window.__ModuleLoader__.load({ id: "dsh-jujutsu", factory: factory });
})();
