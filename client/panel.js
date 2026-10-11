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
 * `SettingsFormModel` for the drafts, **`ConfigField`** for each field, and
 * **`DisclosureRow`** for each group. Nothing here draws its own label, input,
 * reset or validation message.
 *
 * `ConfigField` is driven by `value: string` plus `choices`:
 *
 * - **no `choices`** → a text input (a path),
 * - **`choices`** → a finite control (an enum, and `["true","false"]` for a
 *   boolean).
 *
 * ## Where it is mounted
 *
 * `plugins.bundle.config`, keyed by the **package name** — the bundle's own
 * page, between its description and its rows. That slot renders `view: 'page'`
 * only, so there is no `summary` branch to get wrong.
 *
 * ## Translation
 *
 * Every string lives in `STRINGS`, keyed, with one entry per locale, and the
 * panel reads them through the `t` the slot supplies (`locale: NS` in the
 * registration). Nothing is written inline. The **display name and one-liner
 * are not here** — those are `locale/<lang>.json`, read by the host through
 * `readPluginMeta`, because they must render before any bundle loads.
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
     * Every string the panel renders, per locale.
     *
     * Keys are flat and prefixed by what they belong to, so a missing
     * translation is visible as a missing key rather than as English leaking
     * into a translated page. `zh` is checked by a test that walks both objects
     * and fails on any key present in one and not the other.
     */
    var STRINGS = {
      en: {
        save: "Save",
        saving: "Saving…",
        saveFailed: "The host did not accept the save.",
        unavailable:
          "This plugin is not currently mounted, so its settings cannot be edited.",
        readOnly: "This deployment stores settings read-only.",
        reset: "Reset to default",
        inherited: "Inherited",
        invalid: "Not a value this field accepts",

        groupGuard: "Guard",
        groupGuardBlurb:
          "What happens when the model reaches for Git inside a Jujutsu workspace.",
        groupInit: "When there is no repository",
        groupInitBlurb:
          "A directory with neither .jj nor .git has no history at all. The plugin can say so.",
        groupPrompt: "Teaching",
        groupPromptBlurb: "What the model is told about version control here.",
        groupBinaries: "Binaries",
        groupBinariesBlurb: "Where jj and jj-hunk are found.",
        groupMaster: "Master switch",
        groupMasterBlurb: "Turns the whole plugin off, guard included.",

        enabledLabel: "Enabled",
        enabledHint:
          "Master switch. Off unregisters everything: no guard, no tools, no prompt injection.",
        guardLabel: "Guard",
        guardHint:
          "deny refuses Git commands inside a Jujutsu workspace. off leaves the guard mounted but inert — useful to watch what it would have caught.",
        readOnlyGitLabel: "Read-only Git",
        readOnlyGitHint:
          "What to do with Git commands that only read (status, log, diff, show, blame). ask prompts; allow is for users who want the model to inspect Git directly. Mutating forms are never covered by this setting.",
        bypassLabel: "Writing Git",
        bypassHint:
          "What to do with Git commands that write (commit, push, checkout, rebase). ask requests a one-call approval; deny never asks; allow disables the guard for these.",
        rememberBypassLabel: "Remember approvals",
        rememberBypassHint:
          "After you approve one Git command, stop asking about that same verb for the rest of the session. In memory only — it does not survive a restart.",
        alertUninitialisedLabel: "Mention missing version control",
        alertUninitialisedHint:
          "When a directory has no version control at all, tell the model so it can offer to initialise one. Off means the plugin stays silent outside a repository.",
        preferJjLabel: "Prefer Jujutsu",
        preferJjHint:
          "Which to suggest when initialising: jj git init (colocated, Git tooling still works) or plain git init. Only used when alertUninitialised is on.",
        injectContextLabel: "Explain Jujutsu in the prompt",
        injectContextHint:
          "Tell the model, in its system prompt, that version control here is Jujutsu. Off means the guard still refuses Git but the model is not told why.",
        teachSkillLabel: "Offer the jj manual",
        teachSkillHint:
          "Offer the jj manual as an on-demand skill. Token-neutral; off only means the model has less to read when it needs depth.",
        jjPathLabel: "jj executable",
        jjPathHint:
          "The jj executable. Change this when jj is not on PATH, or to pin a specific build.",
        jjHunkPathLabel: "jj-hunk executable",
        jjHunkPathHint:
          "The jj-hunk executable. Hunk-level split and squash need it; without it those tools report unavailable rather than failing.",
        hunkInstallLabel: "When jj-hunk is missing",
        hunkInstallHint:
          "What to do when jj-hunk is missing. ask offers a pinned cargo install; never only reports; auto installs without asking.",
      },
      zh: {
        save: "保存",
        saving: "保存中…",
        saveFailed: "宿主未接受本次保存。",
        unavailable: "该插件当前未挂载，因此无法编辑其设置。",
        readOnly: "该部署以只读方式存储设置。",
        reset: "恢复默认值",
        inherited: "继承值",
        invalid: "不是该字段接受的值",

        groupGuard: "拦截",
        groupGuardBlurb: "当模型在 Jujutsu 工作区内尝试使用 Git 时的行为。",
        groupInit: "当目录中没有版本控制",
        groupInitBlurb:
          "既没有 .jj 也没有 .git 的目录完全没有历史记录，插件可以提醒模型。",
        groupPrompt: "引导",
        groupPromptBlurb: "向模型说明此处的版本控制方式。",
        groupBinaries: "可执行文件",
        groupBinariesBlurb: "jj 与 jj-hunk 的查找位置。",
        groupMaster: "总开关",
        groupMasterBlurb: "关闭整个插件，包括拦截功能。",

        enabledLabel: "启用",
        enabledHint: "总开关。关闭后不再注册任何内容：没有拦截、没有工具、也不注入提示。",
        guardLabel: "拦截",
        guardHint:
          "deny 会拒绝 Jujutsu 工作区内的 Git 命令；off 仍挂载拦截器但不生效——适合先观察它本会拦下什么。",
        readOnlyGitLabel: "只读 Git",
        readOnlyGitHint:
          "对只读取的 Git 命令（status、log、diff、show、blame）如何处理。ask 会询问；allow 适合希望模型直接查看 Git 的用户。会写入的命令不受此项影响。",
        bypassLabel: "写入型 Git",
        bypassHint:
          "对会写入的 Git 命令（commit、push、checkout、rebase）如何处理。ask 请求单次批准；deny 从不询问；allow 对这些命令关闭拦截。",
        rememberBypassLabel: "记住批准",
        rememberBypassHint:
          "批准过某个 Git 命令后，本次会话内不再就同一动作重复询问。仅存于内存，重启后失效。",
        alertUninitialisedLabel: "提示缺少版本控制",
        alertUninitialisedHint:
          "当目录完全没有版本控制时告知模型，以便它主动建议初始化。关闭后插件在仓库之外保持静默。",
        preferJjLabel: "优先使用 Jujutsu",
        preferJjHint:
          "初始化时建议哪一种：jj git init（共置仓库，Git 工具链仍可用）或普通 git init。仅在开启「提示缺少版本控制」时生效。",
        injectContextLabel: "在提示中说明 Jujutsu",
        injectContextHint:
          "在系统提示中告知模型此处的版本控制是 Jujutsu。关闭后拦截仍会拒绝 Git，但模型不会知道原因。",
        teachSkillLabel: "提供 jj 手册",
        teachSkillHint:
          "将 jj 手册作为按需技能提供。对 token 影响中性；关闭只意味着模型在需要深入时能读到的内容更少。",
        jjPathLabel: "jj 可执行文件",
        jjPathHint: "jj 可执行文件。当 jj 不在 PATH 中，或需要固定某个构建时修改此项。",
        jjHunkPathLabel: "jj-hunk 可执行文件",
        jjHunkPathHint:
          "jj-hunk 可执行文件。按块拆分与合并需要它；缺失时相关工具会报告不可用，而不是直接失败。",
        hunkInstallLabel: "缺少 jj-hunk 时",
        hunkInstallHint:
          "jj-hunk 缺失时的行为。ask 提议使用固定版本的 cargo 安装；never 仅报告；auto 直接安装。",
      },
    };

    /**
     * The groups, in the order the panel draws them, referencing string keys.
     *
     * The keys are the contract: a group whose `titleKey` is missing from a
     * locale renders that key, which is visible immediately rather than
     * silently falling back to English.
     */
    var GROUPS = [
      { id: "guard", titleKey: "groupGuard", blurbKey: "groupGuardBlurb",
        fields: ["guard", "readOnlyGit", "bypass", "rememberBypass"] },
      { id: "init", titleKey: "groupInit", blurbKey: "groupInitBlurb",
        fields: ["alertUninitialised", "preferJj"] },
      { id: "prompt", titleKey: "groupPrompt", blurbKey: "groupPromptBlurb",
        fields: ["injectContext", "teachSkill"] },
      { id: "binaries", titleKey: "groupBinaries", blurbKey: "groupBinariesBlurb",
        fields: ["jjPath", "jjHunkPath", "hunkInstall"] },
      { id: "master", titleKey: "groupMaster", blurbKey: "groupMasterBlurb",
        fields: ["enabled"] },
    ];

    /**
     * The fields: kind, string keys, and the choices `ConfigField` renders.
     *
     * `choices` empty means a text input; a finite list means a choice control.
     */
    var FIELDS = {
      enabled: { kind: "boolean", labelKey: "enabledLabel", hintKey: "enabledHint" },
      guard: { kind: "enum", labelKey: "guardLabel", hintKey: "guardHint",
        choices: ["deny", "off"] },
      readOnlyGit: { kind: "enum", labelKey: "readOnlyGitLabel", hintKey: "readOnlyGitHint",
        choices: ["deny", "ask", "allow"] },
      bypass: { kind: "enum", labelKey: "bypassLabel", hintKey: "bypassHint",
        choices: ["ask", "deny", "allow"] },
      rememberBypass: { kind: "boolean", labelKey: "rememberBypassLabel",
        hintKey: "rememberBypassHint" },
      alertUninitialised: { kind: "boolean", labelKey: "alertUninitialisedLabel",
        hintKey: "alertUninitialisedHint" },
      preferJj: { kind: "boolean", labelKey: "preferJjLabel", hintKey: "preferJjHint" },
      injectContext: { kind: "boolean", labelKey: "injectContextLabel",
        hintKey: "injectContextHint" },
      teachSkill: { kind: "boolean", labelKey: "teachSkillLabel", hintKey: "teachSkillHint" },
      jjPath: { kind: "text", labelKey: "jjPathLabel", hintKey: "jjPathHint" },
      jjHunkPath: { kind: "text", labelKey: "jjHunkPathLabel", hintKey: "jjHunkPathHint" },
      hunkInstall: { kind: "enum", labelKey: "hunkInstallLabel", hintKey: "hunkInstallHint",
        choices: ["ask", "never", "auto"] },
    };

    /** The choices `ConfigField` renders for a boolean. */
    var BOOLEAN_CHOICES = ["true", "false"];

    /** The choices for one field: an empty list means a text input. */
    function choicesOf(meta) {
      if (meta.kind === "boolean") return BOOLEAN_CHOICES;
      if (meta.kind === "enum") return meta.choices;
      return [];
    }

    /** A boolean field, staged as text. */
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
     * Translate a key, falling back to the key itself.
     *
     * The fallback is the key rather than English on purpose: a missing
     * translation should be obvious in the UI, not hidden behind a language the
     * reader may not have asked for.
     */
    function translator(props) {
      var t = props.t;
      return function (key) {
        if (typeof t !== "function") return key;
        var value = t(key);
        return typeof value === "string" && value.length > 0 ? value : key;
      };
    }

    /**
     * One field, rendered by `ConfigField`.
     *
     * The handlers come from `model.actions()`, **not** from the field state.
     * `SettingsFieldState` is `{ text, overridden, invalid }` and nothing else —
     * it carries no `onEdit`/`onReset`/`disabled`. Reading handlers off it
     * yields `undefined`, and `ConfigField` throwing on the first keystroke
     * abdicates the whole entry: the slot retires a crashing registration from
     * its cell while leaving it on the ledger, so the page renders nothing and
     * the panel shows up as an occupant with `active: false`. That is exactly
     * what happened here, and it is why "registered" was never the same as
     * "working".
     */
    function control(name, model, actions, shell, t) {
      var meta = FIELDS[name];
      var state = model.field(name);
      return h(primitives.ConfigField, {
        key: name,
        label: t(meta.labelKey),
        value: state.text,
        secret: false,
        choices: choicesOf(meta),
        // The form, not the field, owns writability.
        disabled: shell.writable !== true,
        overridden: state.overridden,
        invalid: state.invalid,
        labels: {
          reset: t("reset"),
          inherited: t("inherited"),
          invalid: t("invalid"),
        },
        onChange: function (value) {
          actions.edit(name, value);
        },
        onReset: function () {
          actions.resetField(name);
        },
      });
    }

    /**
     * One collapsible group of fields.
     *
     * `DisclosureRow` is controlled (`open` + `onToggle`, no internal state), so
     * the open state lives here. Groups start open: a settings page whose fields
     * are all hidden makes the user click to discover what is configurable.
     */
    function Group(props) {
      var pair = react.useState(true);
      var open = pair[0];
      var setOpen = pair[1];
      var t = props.t;
      return h(
        primitives.DisclosureRow,
        {
          icon: null,
          title: t(props.group.titleKey),
          open: open,
          expandable: true,
          onToggle: function () {
            setOpen(!open);
          },
          expandOnRowClick: true,
        },
        h("p", { key: "blurb" }, t(props.group.blurbKey)),
        props.group.fields.map(function (name) {
          return control(name, props.model, props.actions, props.shell, t);
        }),
      );
    }

    /** The panel: the form frame, then one disclosure per group. */
    function Panel(props) {
      var t = translator(props);
      var model = props.model;
      var shell = model.shell();
      // `shell()` is state only; the verbs live in `actions()`. `SettingsForm`
      // takes `onSave`/`onDiscard`, which are NOT fields of the shell.
      var actions = model.actions();
      var blocks = GROUPS.map(function (group) {
        return h(Group, {
          key: group.id,
          group: group,
          model: model,
          actions: actions,
          shell: shell,
          t: t,
        });
      });
      return h(
        primitives.SettingsForm,
        {
          labels: {
            save: t("save"),
            saving: t("saving"),
            saveFailed: t("saveFailed"),
            unavailable: t("unavailable"),
            readOnly: t("readOnly"),
          },
          state: shell,
          onSave: actions.save,
          onDiscard: actions.discard,
        },
        blocks,
      );
    }

    /** Register the panel. */
    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, { en: STRINGS.en, zh: STRINGS.zh });
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
    exports.STRINGS = STRINGS;
    exports.Panel = Panel;
    exports.booleanField = booleanField;
    exports.enumField = enumField;
    exports.buildSpecs = buildSpecs;
    exports.choicesOf = choicesOf;

    return module.exports;
  };

  window.__ModuleLoader__.load({ id: "dsh-jujutsu", factory: factory });
})();
