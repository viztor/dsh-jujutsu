/**
 * The plugin's configuration schema — and the plugin's admin panel.
 *
 * Uses the harness's own `@deepseek-ai/schemastery` fork rather than the public
 * package: the fork implements the `.volatile()` surface the loader and the
 * settings projection rely on.
 *
 * ## Two things every field must carry, for different reasons
 *
 * **`.volatile()`** is not decoration. `dsh-settings` projects
 * `volatileForm(schema)` and **drops the entry entirely** when no field is
 * volatile, so a non-volatile schema means the row never appears in Settings at
 * all (`docs/29-state-config-and-sandbox-surfaces.md` §2).
 *
 * **`.description()`** is what makes the panel readable. The projected form
 * carries it through `toJSON()`, and without it a user sees `readOnlyGit: "ask"`
 * and has to guess. Every field here answers three questions in one sentence:
 * what it does, which way it defaults, and what changes if you move it.
 *
 * ## What the panel is, and what it is not
 *
 * This schema **is** the host half of the admin panel. It is projected into
 * JSON Schema with `x-cordis.volatile` on every field, and the Web UI renders it
 * on the plugin's row. The browser half is `src/client/panel.ts`, built to
 * `lib/client.js`, and it draws these fields rather than duplicating the list.
 *
 * @module dsh-jujutsu/config
 */

import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  /** `deny` enforces; `off` installs the listeners but always calls `next()`. */
  /**
   * The master guard switch. Boolean rather than an enum of `deny`/`off`:
   * there are two states and no third, and an enum of two is a boolean that
   * renders as a segmented control — which is what it did, showing "Deny" and
   * "Off" as if they were choices of equal weight rather than on and off.
   *
   * `off` leaves the listener registered but inert, so it is a way to watch what
   * the guard *would* have caught without losing the protection for the session.
   */
  guard: z
    .boolean()
    .default(true)
    .description(
      "On refuses Git commands inside a Jujutsu workspace. Off leaves the guard mounted but inert -- useful to watch what it would have caught.",
    )
    .volatile(),

  readOnlyGit: z
    .union([z.const("deny"), z.const("ask"), z.const("allow")])
    .default("ask")
    .description(
      "What to do with Git commands that only read. Always read-only: status, log, diff, show, blame, rev-parse, describe. Read-only only in their listing form: branch, tag, remote, config, stash -- so `git branch` reads but `git branch -d` writes. ask prompts; allow is for users who want the model to inspect Git directly.",
    )
    .volatile(),

  /**
   * The D2 bypass posture. `ask` routes through the approval channel for a
   * one-call grant; `deny` never asks; `allow` is the user's explicit opt-out.
   * See docs/17-bypass-and-approval.md.
   */
  bypass: z
    .union([z.const("deny"), z.const("ask"), z.const("allow")])
    .default("ask")
    .description(
      "What to do with every other Git command: commit, push, checkout, rebase, and anything the read-only setting does not list -- including the writing form of a verb it does. ask requests a one-call approval; deny never asks; allow disables the guard for these.",
    )
    .volatile(),

  /** Remember an approved verb for the rest of the session. */
  rememberBypass: z
    .boolean()
    .default(true)
    .description(
      "After you approve one Git command, stop asking about that same verb for the rest of the session. In memory only — it does not survive a restart.",
    )
    .volatile(),

  /** `jj` binary. Resolved once per session. */
  jjPath: z
    .string()
    .default("jj")
    .description(
      "The jj executable. Change this when jj is not on PATH, or to pin a specific build.",
    )
    .volatile(),

  /** `jj-hunk` binary. Resolution and version detection are tiered. */
  jjHunkPath: z
    .string()
    .default("jj-hunk")
    .description(
      "The jj-hunk executable. Hunk-level split and squash need it; without it those tools report unavailable rather than failing.",
    )
    .volatile(),

  /**
   * `jj-hunk` provisioning: `ask` offers to install via `cargo`, `never` only
   * reports, `auto` installs without asking. Defaults to `ask`; `auto` exists
   * and is deliberately not the default (docs/19-jj-hunk-provisioning.md).
   */
  hunkInstall: z
    .union([z.const("ask"), z.const("never"), z.const("auto")])
    .default("ask")
    .description(
      "What to do when jj-hunk is missing. ask offers a pinned cargo install; never only reports; auto installs without asking.",
    )
    .volatile(),

  /**
   * Teach the `jj` manual through a runtime skill instead of the system prompt.
   * Token-neutral — the split is for *depth*, not cost
   * (docs/32-probe-results-teaching.md) — so this can be turned off with no
   * budget consequence.
   */
  teachSkill: z
    .boolean()
    .default(true)
    .description(
      "Offer the jj manual as an on-demand skill. Token-neutral; off only means the model has less to read when it needs depth.",
    )
    .volatile(),

  /** Inject the rule and the workspace state into the prompt. */
  injectContext: z
    .boolean()
    .default(true)
    .description(
      "Tell the model, in its system prompt, that version control here is Jujutsu. Off means the guard still refuses Git but the model is not told why.",
    )
    .volatile(),

  /**
   * When a directory has neither `.jj` nor `.git`, say so.
   *
   * This is the case the plugin used to be silent about: the guard had nothing
   * to protect, so it said nothing, and the agent never mentioned that the work
   * it was doing had no version control at all.
   */
  alertUninitialised: z
    .boolean()
    .default(true)
    .description(
      "When a directory has no version control at all, tell the model so it can offer to initialise one. Off means the plugin stays silent outside a repository.",
    )
    .volatile(),

  /**
   * Which version control to suggest when a directory has none.
   *
   * Jujutsu is the default because this plugin exists to make the harness
   * jj-native, and because `jj git init` produces a colocated repository that
   * Git tooling can still read — so preferring jj costs the user nothing.
   */
  preferJj: z
    .boolean()
    .default(true)
    .description(
      "Which to suggest when initialising: jj git init (colocated, Git tooling still works) or plain git init. Only used when alertUninitialised is on.",
    )
    .volatile(),
});
