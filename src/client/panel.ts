/**
 * `dsh-jujutsu` admin panel — the client half of the bundle.
 *
 * ## Why this is TypeScript
 *
 * It was hand-written JavaScript for three revisions, on the reasoning that the
 * web client loads a client bundle as a *script* and so the file must "already
 * be JavaScript". That reasoning was wrong twice over: the build already emits
 * JavaScript, and the sibling package authors `src/client.ts` and builds
 * `lib/client.js` in this very factory format.
 *
 * The cost of the shortcut was every bug this panel had. All three were type
 * errors that `tsc` would have refused:
 *
 *   state.onEdit      — `SettingsFieldState` is `{ text, overridden, invalid }`
 *   shell.onSave      — `SettingsFormShell` is state only
 *   props.actions     — the verbs arrive spread on the injected props
 *
 * Each shipped, each blanked the panel, and each was found by staring at a
 * screenshot. The interfaces below are transcribed from the harness's own
 * `.d.ts` files for exactly this reason: with them declared, those three lines
 * do not compile.
 *
 * ## Built-in components only
 *
 * `SettingsForm` for the frame, `SettingsFormModel` for the drafts,
 * `SettingsValueField` for each field, `DisclosureRow` for each group. Nothing
 * here draws its own label, input, reset or validation message.
 *
 * ## Where it is mounted
 *
 * `plugins.bundle.config`, keyed by the package name — the bundle's own page,
 * between its description and its rows.
 *
 * @module dsh-jujutsu/client/panel
 */

// ---------------------------------------------------------------------------
// The harness's client types, transcribed from the installed `.d.ts` files.
//
// These are declared rather than imported because the primitives package lives
// in the harness's own install, not in this project's. Keeping them minimal is
// deliberate: each one is a claim about the harness that a test can check
// against the real declaration.
// ---------------------------------------------------------------------------

/** One field's state. **No handlers and no `disabled`** — see `SettingsFormActions`. */
interface SettingsFieldState {
  readonly text: string;
  readonly overridden: boolean;
  readonly invalid: boolean;
}

/** Form state every plugin card shares. State only; the verbs live in `actions()`. */
interface SettingsFormShell {
  /** False while the namespace is not served; the card renders nothing. */
  readonly available: boolean;
  readonly writable: boolean;
  readonly dirty: boolean;
  readonly invalid: boolean;
  readonly saving: boolean;
  readonly failed: boolean;
}

/** The edit, reset, save and discard verbs, bound to one form. */
interface SettingsFormActions {
  edit(field: string, text: string): void;
  resetField(field: string): void;
  save(): void;
  discard(): void;
}

/** A projection of the form, rebuilt on scope and draft changes. */
interface SnapshotStore<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

/** The form's public face, as far as this panel uses it. */
interface SettingsFormModelLike {
  shell(): SettingsFormShell;
  field(field: string): SettingsFieldState;
  actions(): SettingsFormActions;
  bind<S>(project: () => S): SnapshotStore<S>;
  dispose(): void;
}

/** A conversion spec: how one field's draft becomes a write. */
interface SettingsFieldSpec {
  readonly field: string;
  format(value: unknown): string;
  parse(text: string): { kind: "set"; value: unknown } | undefined;
}

/**
 * What every settings field control needs, as `SettingsValueField` takes it.
 *
 * Note what is absent: **no `choices`**. The harness's client-facing field is a
 * text control whose accepted values are decided by the field's *spec*, not by
 * a list the control renders — so an enum is typed, and the spec rejects what it
 * does not accept. There is no select to pass options to.
 */
interface SettingsValueFieldProps {
  /** Stable id associating the label with its control. */
  id: string;
  label: string;
  /** One-line explanation rendered under the control. */
  hint?: string;
  /** Draft text this control renders. */
  text: string;
  overridden: boolean;
  invalid: boolean;
  /** Copy for the overridden badge. */
  overriddenLabel: string;
  /** Copy for the reset control. */
  resetLabel: string;
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string;
  /** Disables the control: read-only document, or an unavailable namespace. */
  disabled: boolean;
  onEdit(text: string): void;
  onReset(): void;
}

/** Props every configuration slot entry receives from the page. */
interface PluginConfigViewProps {
  readonly view: "summary" | "page";
}

interface DisclosureRowProps {
  icon: unknown;
  title: string;
  open: boolean;
  expandable: boolean;
  onToggle(): void;
  expandOnRowClick?: boolean;
  children?: unknown;
}

interface SettingsFormProps {
  labels: {
    save: string;
    saving: string;
    saveFailed: string;
    unavailable: string;
    readOnly: string;
  };
  state: SettingsFormShell;
  onSave(): void;
  onDiscard(): void;
  children?: unknown;
}

/** What the client runtime resolves for this bundle. */
interface ClientPrimitives {
  createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
  useState<S>(initial: S): [S, (next: S) => void];
  useSyncExternalStore<S>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => S,
    getServerSnapshot?: () => S,
  ): S;
}

interface ClientPrimitivesModule {
  /**
   * The client-facing field control.
   *
   * NOT `ConfigField`: that component exists in the package but is not exported
   * from its index, because it belongs to the *generated* forms rather than to
   * plugin UIs. Requiring it yields `undefined`, and `createElement(undefined)`
   * throws "Element type is invalid" — which the slot answers by retiring the
   * entry, leaving a page with no form and no explanation.
   */
  SettingsValueField: (props: SettingsValueFieldProps) => unknown;
  DisclosureRow: (props: DisclosureRowProps) => unknown;
  SettingsForm: (props: SettingsFormProps) => unknown;
  SettingsFormModel: new (
    scope: unknown,
    specs: SettingsFieldSpec[],
    secrets?: unknown[],
  ) => SettingsFormModelLike;
  settingsTextField(field: string): SettingsFieldSpec;
}

/** The Cordis context the client half is applied with. */
interface ClientContext {
  effect(callback: () => unknown, label?: string): unknown;
  locale: { register(namespace: string, dictionaries: unknown): unknown };
  configForms: {
    get(namespace: string): unknown;
    whileServed(namespaces: readonly string[], callback: () => unknown): unknown;
  };
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(
      spec: {
        name: string;
        key: string;
        locale?: string;
        inject?: () => Record<string, unknown>;
      },
      component: (props: never) => unknown,
    ): unknown;
  };
}

// ---------------------------------------------------------------------------
// The bundle's runtime dependencies. The loader hands the factory a `require`
// that resolves these from the harness's own client graph.
// ---------------------------------------------------------------------------

// `require` is the factory argument the wrapper passes in; the host's
// `@types/node` declares it, and the client runtime supplies the real one.
const primitives = require("@deepseek-ai/dsh-client-ui-primitives") as ClientPrimitivesModule;
const react = require("react") as ClientPrimitives;

const h = react.createElement;

/** The settings namespace. Must equal the host half's exported `name`. */
const NS = "dsh-jujutsu";

/**
 * The client services this entry needs.
 *
 * Exported for Cordis, and **load-bearing**: without it the entry is injected
 * nothing, `apply` throws on the first service it reaches, and the failure is
 * not local — the entry does not activate, so the web boot reports
 * "1 entry did not activate" and the whole page fails to load.
 */
const inject = ["slots", "locale", "configForms"];

/** The English dictionary key. */
const EN = "en";

/**
 * Every string the panel renders, per locale.
 *
 * Keys are prefixed by what they belong to, so a missing translation shows up as
 * a missing key rather than as English leaking into a translated page.
 */
const STRINGS: Record<string, Record<string, string>> = {
  en: {
    save: "Save",
    saving: "Saving…",
    saveFailed: "The host did not accept the save.",
    unavailable: "This plugin is not currently mounted, so its settings cannot be edited.",
    readOnly: "This deployment stores settings read-only.",
    reset: "Reset to default",
    overridden: "Overridden",
    inherited: "Inherited",
    invalid: "Not a value this field accepts",

    groupGuard: "Guard",
    groupGuardBlurb: "What happens when the model reaches for Git inside a Jujutsu workspace.",
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
    jjPathHint: "The jj executable. Change this when jj is not on PATH, or to pin a specific build.",
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
    overridden: "已覆盖",
    inherited: "继承值",
    invalid: "不是该字段接受的值",

    groupGuard: "拦截",
    groupGuardBlurb: "当模型在 Jujutsu 工作区内尝试使用 Git 时的行为。",
    groupInit: "当目录中没有版本控制",
    groupInitBlurb: "既没有 .jj 也没有 .git 的目录完全没有历史记录，插件可以提醒模型。",
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

/** Field metadata: the string keys, and the values the spec accepts. */
interface FieldMeta {
  readonly kind: "boolean" | "enum" | "text";
  readonly labelKey: string;
  readonly hintKey: string;
  readonly choices?: readonly string[];
}

const FIELDS: Record<string, FieldMeta> = {
  enabled: { kind: "boolean", labelKey: "enabledLabel", hintKey: "enabledHint" },
  guard: { kind: "enum", labelKey: "guardLabel", hintKey: "guardHint", choices: ["deny", "off"] },
  readOnlyGit: {
    kind: "enum",
    labelKey: "readOnlyGitLabel",
    hintKey: "readOnlyGitHint",
    choices: ["deny", "ask", "allow"],
  },
  bypass: {
    kind: "enum",
    labelKey: "bypassLabel",
    hintKey: "bypassHint",
    choices: ["ask", "deny", "allow"],
  },
  rememberBypass: { kind: "boolean", labelKey: "rememberBypassLabel", hintKey: "rememberBypassHint" },
  alertUninitialised: {
    kind: "boolean",
    labelKey: "alertUninitialisedLabel",
    hintKey: "alertUninitialisedHint",
  },
  preferJj: { kind: "boolean", labelKey: "preferJjLabel", hintKey: "preferJjHint" },
  injectContext: { kind: "boolean", labelKey: "injectContextLabel", hintKey: "injectContextHint" },
  teachSkill: { kind: "boolean", labelKey: "teachSkillLabel", hintKey: "teachSkillHint" },
  jjPath: { kind: "text", labelKey: "jjPathLabel", hintKey: "jjPathHint" },
  jjHunkPath: { kind: "text", labelKey: "jjHunkPathLabel", hintKey: "jjHunkPathHint" },
  hunkInstall: {
    kind: "enum",
    labelKey: "hunkInstallLabel",
    hintKey: "hunkInstallHint",
    choices: ["ask", "never", "auto"],
  },
};

interface GroupMeta {
  readonly id: string;
  readonly titleKey: string;
  readonly blurbKey: string;
  readonly fields: readonly string[];
}

const GROUPS: readonly GroupMeta[] = [
  {
    id: "guard",
    titleKey: "groupGuard",
    blurbKey: "groupGuardBlurb",
    fields: ["guard", "readOnlyGit", "bypass", "rememberBypass"],
  },
  {
    id: "init",
    titleKey: "groupInit",
    blurbKey: "groupInitBlurb",
    fields: ["alertUninitialised", "preferJj"],
  },
  {
    id: "prompt",
    titleKey: "groupPrompt",
    blurbKey: "groupPromptBlurb",
    fields: ["injectContext", "teachSkill"],
  },
  {
    id: "binaries",
    titleKey: "groupBinaries",
    blurbKey: "groupBinariesBlurb",
    fields: ["jjPath", "jjHunkPath", "hunkInstall"],
  },
  { id: "master", titleKey: "groupMaster", blurbKey: "groupMasterBlurb", fields: ["enabled"] },
];

/** The two drafts a boolean field accepts, as the spec sees them. */
const BOOLEAN_CHOICES: readonly string[] = ["true", "false"];

/** The choices for one field: an empty list means a text input. */
function choicesOf(meta: FieldMeta): readonly string[] {
  if (meta.kind === "boolean") return BOOLEAN_CHOICES;
  if (meta.kind === "enum") return meta.choices ?? [];
  return [];
}

/** A boolean field, staged as text. */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === "boolean" ? String(value) : ""),
    parse: (text) => {
      const t = String(text).trim().toLowerCase();
      if (t === "true") return { kind: "set", value: true };
      if (t === "false") return { kind: "set", value: false };
      return undefined;
    },
  };
}

/** An enum field, staged as text, blocking anything outside its choices. */
function enumField(field: string, choices: readonly string[]): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => {
      const t = String(text).trim();
      return choices.includes(t) ? { kind: "set", value: t } : undefined;
    },
  };
}

/** Build every spec from `FIELDS`, so the two cannot disagree. */
function buildSpecs(): SettingsFieldSpec[] {
  return Object.keys(FIELDS).map((name) => {
    const meta = FIELDS[name] as FieldMeta;
    if (meta.kind === "boolean") return booleanField(name);
    if (meta.kind === "enum") return enumField(name, meta.choices ?? []);
    return primitives.settingsTextField(name);
  });
}

/** What the panel receives from its slot entry. */
interface PanelProps extends PluginConfigViewProps {
  readonly t?: (key: string) => string;
  readonly store: SnapshotStore<{ fields: Record<string, SettingsFieldState>; shell: SettingsFormShell }>;
  readonly edit: (field: string, text: string) => void;
  readonly resetField: (field: string) => void;
  readonly save: () => void;
  readonly discard: () => void;
}

/**
 * Translate a key, falling back to the key itself.
 *
 * The fallback is the key rather than English on purpose: a missing translation
 * should be obvious in the UI, not hidden behind a language the reader may not
 * have asked for.
 */
function translator(props: PanelProps): (key: string) => string {
  const t = props.t;
  return (key) => {
    if (typeof t !== "function") return key;
    const value = t(key);
    return typeof value === "string" && value.length > 0 ? value : key;
  };
}

/**
 * One field, rendered by `SettingsValueField`.
 *
 * The control is a text box for every kind, enums included. That is the
 * harness's design rather than a limitation here: the field's *spec* decides
 * which drafts it accepts, and the control never rewrites what the user typed.
 * The accepted values are listed in the hint instead, which is why every field
 * carries one.
 */
function control(
  name: string,
  state: SettingsFieldState,
  props: PanelProps,
  shell: SettingsFormShell,
  t: (key: string) => string,
): unknown {
  const meta = FIELDS[name] as FieldMeta;
  return h(primitives.SettingsValueField, {
    key: name,
    // Stable and unique per field, so the label's `htmlFor` finds its control.
    id: `dsh-jujutsu-${name}`,
    label: t(meta.labelKey),
    hint: t(meta.hintKey),
    text: state.text,
    overridden: state.overridden,
    invalid: state.invalid,
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    invalidLabel: t("invalid"),
    disabled: shell.writable !== true,
    onEdit: (text: string) => props.edit(name, text),
    onReset: () => props.resetField(name),
  } satisfies SettingsValueFieldProps & { key: string });
}

interface GroupProps {
  readonly group: GroupMeta;
  readonly fields: Record<string, SettingsFieldState>;
  readonly props: PanelProps;
  readonly shell: SettingsFormShell;
  readonly t: (key: string) => string;
}

/**
 * One collapsible group of fields.
 *
 * `DisclosureRow` is controlled (`open` + `onToggle`, no internal state), so the
 * open state lives here. Groups start open: a settings page whose fields are all
 * hidden makes the user click to discover what is configurable.
 */
function Group(props: GroupProps): unknown {
  try {
    return renderGroup(props);
  } catch (error) {
    // React calls this component during ITS render pass, so the try/catch in
    // `Panel` does not cover it: `Panel` only builds the element. Without this,
    // a crash in a field escapes every guard, the slot retires the entry, and
    // the page goes blank with nothing said.
    return h(
      "p",
      { role: "alert" },
      `dsh-jujutsu: the "${props.group.id}" group failed to render. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function renderGroup(props: GroupProps): unknown {
  const pair = react.useState(true);
  const open = pair[0];
  const setOpen = pair[1];
  const t = props.t;
  return h(
    primitives.DisclosureRow,
    {
      icon: null,
      title: t(props.group.titleKey),
      open,
      expandable: true,
      onToggle: () => setOpen(!open),
      expandOnRowClick: true,
    } satisfies DisclosureRowProps,
    h("p", { key: "blurb" }, t(props.group.blurbKey)),
    props.group.fields.map((name) =>
      control(name, props.fields[name] as SettingsFieldState, props.props, props.shell, t),
    ),
  );
}

/**
 * The panel: the form frame, then one disclosure per group.
 *
 * ## Why this subscribes instead of reading the model
 *
 * `SettingsFormShell.available` is documented as "false while the namespace is
 * not served to this client; **the card renders nothing**". A panel that reads
 * `model.shell()` once, during the first render, sees `available: false` and
 * draws nothing — and with no subscription it never renders again. The harness's
 * own cards bind a projection and read it through `useSyncExternalStore`, so the
 * card re-renders the moment the namespace arrives. `bind` is what makes
 * `field()`/`shell()` reactive; alone they are one-shot reads.
 */
function render(props: PanelProps): unknown {
  const REQUIRED = [
    "SettingsValueField",
    "DisclosureRow",
    "SettingsForm",
    "SettingsFormModel",
    "settingsTextField",
  ] as const;
  const absent = REQUIRED.filter((name) => primitives[name] === undefined);
  if (absent.length > 0) {
    return h(
      "p",
      { role: "alert" },
      `dsh-jujutsu: the client primitives are missing ${absent.join(", ")}`,
    );
  }

  const t = translator(props);
  const state = react.useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
    props.store.getSnapshot,
  );
  const shell = state.shell;
  const blocks = GROUPS.map((group) =>
    h(Group, { key: group.id, group, fields: state.fields, props, shell, t }),
  );
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
      onSave: props.save,
      onDiscard: props.discard,
    } satisfies SettingsFormProps,
    blocks,
  );
}

/**
 * The panel entry point.
 *
 * A throwing render is retired from its slot and leaves the page blank, with
 * nothing anywhere saying why — the failure looks exactly like a plugin that has
 * no settings. Reporting it in place is both better behaviour and the only
 * diagnostic available from inside a browser whose console cannot be opened.
 */
function Panel(props: PanelProps): unknown {
  try {
    return render(props);
  } catch (error) {
    return h(
      "p",
      { role: "alert" },
      `dsh-jujutsu: the settings panel failed to render. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Register the panel. */
function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { en: STRINGS[EN], zh: STRINGS.zh });
    } catch (error) {
      return undefined;
    }
  }, "dsh-jujutsu: dictionaries");

  const scope = ctx.configForms.get(NS);
  // No scope, no card. Registering one anyway produces an entry whose
  // `available` is false forever, which renders nothing and looks identical to a
  // working card that simply has no fields.
  if (scope === undefined) return;

  const specs = buildSpecs();
  const model = new primitives.SettingsFormModel(scope, specs, []);
  const store = model.bind(() => ({
    fields: Object.fromEntries(specs.map((spec) => [spec.field, model.field(spec.field)])),
    shell: model.shell(),
  }));

  ctx.effect(() => () => model.dispose(), "dsh-jujutsu: form");

  ctx.effect(() => {
    const stop = ctx.configForms.whileServed([NS], () => {
      const dispose = ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: NS,
            locale: NS,
            // The verbs ride on the injected props, matching the harness's own
            // cards: `SettingsForm` takes `onSave`/`onDiscard` and `ConfigField`
            // takes `onChange`/`onReset`.
            inject: () => ({ store, ...model.actions() }),
          },
          Panel as never,
        ),
      );
      return () => {
        if (typeof dispose === "function") (dispose as () => void)();
      };
    });
    return () => {
      if (typeof stop === "function") (stop as () => void)();
    };
  }, "dsh-jujutsu: panel");
}

export { inject, apply, Panel, FIELDS, GROUPS, STRINGS, buildSpecs, choicesOf, booleanField, enumField };
