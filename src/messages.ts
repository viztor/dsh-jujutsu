/**
 * The literal denial copy for the guard: the Git → `jj` verb rows and their
 * messages, the generic fallback, the destructive-path and write-protection
 * strings, the low-confidence string, and the read-only classification.
 *
 * **This module is transcription, not authoring.** The source of truth is
 * `docs/25-prompt-copy.md` §2 — every `reason` and every `display` below is
 * copied verbatim from it (43 verb rows + 1 R3–R5 fallback + 3 destructive-path
 * strings + 2 write-protection strings + 1 low-confidence string = 50 messages,
 * plus the 11 `displayReason` variants in §2.3). The row inventory, the `match`
 * tokens and the DENY/SPECIAL classification come from
 * `docs/15-verb-mapping.md` §1; the `git init` correction is `docs/14` §R7; the
 * destructive-path posture and the `.git`/`.jj` write rules are `SPEC.md` §5.7
 * and `docs/14` §D6. If this file and `docs/25` ever disagree, the document
 * wins — and a future edit that rewords a string here has broken the product,
 * because the copy *is* the product (copy rule 1: name the exact command).
 *
 * Three deliberate absences, all faithful to the sources:
 *
 * - `docs/15` §1 lists 46 rows, but its last three are ALLOW (`jj <anything>`,
 *   the `jj git …` carve-out, `gh …`). They carry no message and
 *   {@link Classification} has no `allow` member, so they are represented here
 *   by *not being a row* — `verbs.ts` allows them by finding no match.
 * - `Message.explain` is never populated: `docs/25` §2 defines exactly two
 *   strings per message (the `reason` and the `displayReason`), and no long-form
 *   post-execute text exists in the docs. Inventing one is not transcription.
 * - Rows whose verb is not named in a `docs/25` §2.3 family reuse their own
 *   `reason` as the `display`, so the approval prompt still names the exact `jj`
 *   command. No new string is minted.
 *
 * **These strings are the fallback, not always the last word.** When
 * `translate.ts` finds a concrete `jj` command for the arguments as typed, the
 * guard composes `Refused: git <as typed>. Run: <command>` instead and these
 * strings are not sent (`docs/25` §2.4). They remain the copy for every
 * gesture static analysis declines to translate — which is why they must stay
 * good on their own: a model refused `git add` gets only the string below, and
 * no command exists to give it instead.
 *
 * A runtime assertion at the bottom enforces the ≤240-character budget on every
 * `reason` at module load.
 *
 * @module dsh-jujutsu/messages
 */

/** What the guard does with a matched Git invocation. */
export type Classification = "deny" | "ask" | "special";

export interface Message {
  /** The terse actionable line that becomes `Error: <reason>`. ≤240 chars. */
  readonly reason: string;
  /**
   * The short variant a human sees in the approval prompt.
   *
   * Optional, and usually absent. Thirteen of the 43 rows had it set to a
   * verbatim copy of `reason`, which is a drift waiting to happen: the two are
   * edited by hand and only one of them is read by any test. Absent means "there
   * is nothing shorter to say", and the reason stands in.
   */
  readonly display?: string;
  /** The longer explanation, attached via `tools/post-execute`. */
  readonly explain?: string;
}

export interface VerbRow {
  /** Git subcommand this row matches, e.g. ["commit"] or ["branch", "-d"]. */
  readonly match: readonly string[];
  readonly classification: Classification;
  readonly message: Message;
}

/** The `docs/25` §2 copy rule 2 budget, asserted at module load below. */
export const MAX_REASON_CHARS = 240;

/**
 * The 11 `displayReason` variants from `docs/25` §2.3, keyed by the family name
 * that document uses. These are the short strings a human sees in the approval
 * prompt; the full `reason` stays attached to the call (`docs/17`).
 */
export const DISPLAY_REASONS = {
  readOnly:
    "Run a read-only Git command in this Jujutsu workspace? The equivalent is jj status, jj log, jj diff, jj show, or jj file annotate.",
  commit: 'Run git commit? The Jujutsu equivalent is jj commit -m "<msg>".',
  add: "Run git add? Jujutsu has no staging area; files are tracked automatically. See jj status or jj diff.",
  branch:
    "Run a Git branch command? Jujutsu calls these bookmarks: jj bookmark list / create / delete.",
  checkout:
    "Run a Git checkout or switch? The Jujutsu equivalents are jj new <rev> and jj edit <rev>.",
  rebase: "Run a Git rebase or merge? The Jujutsu equivalents are jj rebase and jj new @ <rev>.",
  reset:
    "Run a Git reset, restore, or stash? The Jujutsu equivalents are jj restore <paths>, jj abandon, and jj new @-.",
  remote:
    "Run a Git remote command? The Jujutsu equivalents are jj git fetch and jj git push --bookmark <name>.",
  destructive:
    "Delete the .git or .jj component? This is unrecoverable and jj cannot restore it. Approve only if you intend to destroy this repository.",
  writeProtected:
    "Write inside .jj or .git? This corrupts the state Jujutsu reads. Use jj op restore <opId> instead.",
  lowConfidence:
    "Run a command whose program cannot be resolved? Approve only if you are sure it does not invoke Git.",
} as const;

/**
 * The 43 message-bearing rows of `docs/15` §1, with `docs/25` §2.1 copy.
 *
 * **Ordering is significant.** Within a verb family the specific form precedes
 * the general one (`["commit", "--amend"]` before `["commit"]`), so a
 * first-match matcher is correct; a longest-match matcher is correct too.
 *
 * **`match` is an argv prefix** taken from the row's Git command, with pure
 * positional placeholders dropped: `git add <path>` is `["add"]`, which is also
 * that verb's family row. One row needs a positional to stay distinct from its
 * bare sibling — `git branch <name>` is `["branch", "<name>"]`, where a token in
 * angle brackets denotes one non-flag argument. `git -C <dir> <sub>` is `["-C"]`
 * and matches the leading global-option position, not a subcommand.
 */
export const VERB_ROWS: readonly VerbRow[] = [
  {
    match: ["status"],
    classification: "deny",
    message: {
      reason:
        "Refused: git status describes a Git working tree that does not exist here. Run: jj status",
      display: DISPLAY_REASONS.readOnly,
    },
  },
  {
    match: ["diff"],
    classification: "deny",
    message: {
      reason:
        "Refused: git diff. Jujutsu has no staging index. Run: jj diff for the working-copy change, or jj diff -r <rev> for another revision.",
      display: DISPLAY_REASONS.readOnly,
    },
  },
  {
    match: ["log"],
    classification: "deny",
    message: {
      reason:
        "Refused: git log. Run: jj log. Use jj log -r '::@' for ancestors of @, or jj log -r 'all()' for everything reachable.",
      display: DISPLAY_REASONS.readOnly,
    },
  },
  {
    match: ["add", "-p"],
    classification: "deny",
    message: {
      reason:
        "Refused: git add -p. There is no index to stage into. For hunk selection run: jj-hunk commit --query '<hunkset>' \"msg\" (split and squash also work).",
      display: DISPLAY_REASONS.add,
    },
  },
  {
    match: ["add"],
    classification: "deny",
    message: {
      reason:
        "Refused: git add. Jujutsu has no staging area and tracks new files automatically. Run: jj status or jj diff to see the change.",
      display: DISPLAY_REASONS.add,
    },
  },
  {
    match: ["commit", "--amend"],
    classification: "deny",
    message: {
      reason:
        'Refused: git commit --amend; --amend does not exist. Run: jj describe -m "<msg>" to reword, or jj squash to fold edits into the parent.',
      display: DISPLAY_REASONS.commit,
    },
  },
  {
    match: ["commit", "-m"],
    classification: "deny",
    message: {
      reason: 'Refused: git commit -m. Run: jj commit -m "<msg>".',
      display: DISPLAY_REASONS.commit,
    },
  },
  {
    match: ["commit"],
    classification: "deny",
    message: {
      reason:
        'Refused: git commit. Run: jj commit -m "<msg>". The working copy @ is already a commit; this finalizes it and starts a new empty change on top.',
      display: DISPLAY_REASONS.commit,
    },
  },
  {
    match: ["branch", "-a"],
    classification: "deny",
    message: {
      reason:
        "Refused: git branch -a. Run: jj bookmark list --all-remotes to include remote-tracking bookmarks.",
      display: DISPLAY_REASONS.branch,
    },
  },
  {
    match: ["branch", "-d"],
    classification: "deny",
    message: {
      reason: "Refused: git branch -d. Run: jj bookmark delete <name>.",
      display: DISPLAY_REASONS.branch,
    },
  },
  {
    match: ["branch", "<name>"],
    classification: "deny",
    message: {
      reason: "Refused: git branch <name>. Run: jj bookmark create <name> -r <rev>.",
      display: DISPLAY_REASONS.branch,
    },
  },
  {
    match: ["branch"],
    classification: "deny",
    message: {
      reason:
        "Refused: git branch. Jujutsu calls branches bookmarks. Run: jj bookmark list (alias jj b l).",
      display: DISPLAY_REASONS.branch,
    },
  },
  {
    match: ["checkout", "-b"],
    classification: "deny",
    message: {
      reason:
        "Refused: git checkout -b. Run: jj new to start a change, then jj bookmark create <name> -r @-. Jujutsu has no branch-switch step.",
      display: DISPLAY_REASONS.checkout,
    },
  },
  {
    match: ["checkout"],
    classification: "deny",
    message: {
      reason:
        "Refused: git checkout. Run: jj new <rev> to start a change on top of it, or jj edit <rev> to make it the working copy.",
      display: DISPLAY_REASONS.checkout,
    },
  },
  {
    match: ["switch"],
    classification: "deny",
    message: {
      reason:
        "Refused: git switch. Run: jj new <rev> to start a change on top, or jj edit <rev> to make that revision the working copy.",
      display: DISPLAY_REASONS.checkout,
    },
  },
  {
    match: ["merge"],
    classification: "deny",
    message: {
      reason:
        "Refused: git merge. Run: jj new @ <rev>. A merge is a change with two parents; conflicts are recorded in-tree, so there is no --continue.",
      display: DISPLAY_REASONS.rebase,
    },
  },
  {
    match: ["rebase", "-i"],
    classification: "deny",
    message: {
      reason:
        "Refused: git rebase -i; it is interactive and cannot run headless. Run: jj rebase -r <rev> -B <rev> to reorder, jj squash to fold, jj absorb to auto-place fixes.",
      display: DISPLAY_REASONS.rebase,
    },
  },
  {
    match: ["rebase"],
    classification: "deny",
    message: {
      reason:
        "Refused: git rebase. Run: jj rebase -s <src> -o <dest> to move a subtree, or jj rebase -b <bookmark> -o <dest> to move a branch.",
      display: DISPLAY_REASONS.rebase,
    },
  },
  {
    match: ["reset", "--hard"],
    classification: "deny",
    message: {
      reason:
        "Refused: git reset --hard. Discard edits with jj restore <paths>, or drop the current change with jj abandon. Both are reversible with jj undo.",
      display: DISPLAY_REASONS.reset,
    },
  },
  {
    match: ["reset", "--soft"],
    classification: "deny",
    message: {
      reason:
        "Refused: git reset --soft. Run: jj squash --from @- to fold the parent diff into the working copy. Jujutsu never rewrites a commit in place.",
      display: DISPLAY_REASONS.reset,
    },
  },
  {
    match: ["stash", "pop"],
    classification: "deny",
    message: {
      reason:
        "Refused: git stash pop; there is no stash to pop. Re-enter the parked change with jj edit <change-id> (locate it with jj log).",
      display: DISPLAY_REASONS.reset,
    },
  },
  {
    match: ["stash"],
    classification: "deny",
    message: {
      reason:
        "Refused: git stash; Jujutsu has no stash. Run: jj new @- to park the current change as a sibling commit; find it later with jj log.",
      display: DISPLAY_REASONS.reset,
    },
  },
  {
    match: ["cherry-pick"],
    classification: "deny",
    message: {
      reason:
        "Refused: git cherry-pick. Run: jj duplicate <rev> -o <dest> to copy that change onto another commit.",
      /* display falls back to reason */
    },
  },
  {
    match: ["revert"],
    classification: "deny",
    message: {
      reason:
        "Refused: git revert. Run: jj revert -r <rev> -B @ to insert the inverse of <rev> just before the working copy.",
      /* display falls back to reason */
    },
  },
  {
    match: ["tag"],
    classification: "deny",
    message: {
      reason:
        "Refused: git tag. Run: jj tag list, jj tag set <name> -r <rev>, or jj tag delete <name>.",
      /* display falls back to reason */
    },
  },
  {
    match: ["push", "--force"],
    classification: "deny",
    message: {
      reason:
        "Refused: git push --force; no force flag is needed. jj git push updates the remote only if it matches what you last fetched.",
      display: DISPLAY_REASONS.remote,
    },
  },
  {
    match: ["push"],
    classification: "deny",
    message: {
      reason:
        "Refused: git push. Run: jj git push --bookmark <name>. Jujutsu pushes bookmarks explicitly; there is no implicit current-branch push.",
      display: DISPLAY_REASONS.remote,
    },
  },
  {
    match: ["pull"],
    classification: "deny",
    message: {
      reason:
        "Refused: git pull; Jujutsu has no pull. Run: jj git fetch, then jj rebase -b <bookmark> -o <remote-bookmark> to integrate.",
      display: DISPLAY_REASONS.remote,
    },
  },
  {
    match: ["fetch"],
    classification: "deny",
    message: {
      reason:
        "Refused: git fetch. Run: jj git fetch. The jj prefix matters: jj git fetch is a Jujutsu command and is never refused.",
      /* display falls back to reason */
    },
  },
  {
    match: ["clone"],
    classification: "deny",
    message: {
      reason:
        "Refused: git clone. Run: jj git clone <url> [<dir>]; it creates a colocated repo by default.",
      /* display falls back to reason */
    },
  },
  {
    match: ["remote", "-v"],
    classification: "deny",
    message: {
      reason:
        "Refused: git remote -v. Run: jj git remote list; add one with jj git remote add <name> <url>.",
      display: DISPLAY_REASONS.remote,
    },
  },
  {
    match: ["remote", "add"],
    classification: "deny",
    message: {
      reason: "Refused: git remote add. Run: jj git remote add <name> <url>.",
      display: DISPLAY_REASONS.remote,
    },
  },
  {
    match: ["worktree", "add"],
    classification: "deny",
    message: {
      reason:
        "Refused: git worktree add. Run: jj workspace add <path>. Workspaces are Jujutsu's native multi-working-copy feature.",
      /* display falls back to reason */
    },
  },
  {
    match: ["submodule"],
    classification: "special",
    message: {
      reason:
        "Refused: jj does not manage Git submodules, so this git submodule command has no jj equivalent. Submodules already in the repository keep working — jj records them exactly as Git does. Ask the user to run it.",
      /* display falls back to reason */
    },
  },
  {
    match: ["bisect"],
    classification: "deny",
    message: {
      reason:
        "Refused: git bisect. Run: jj bisect run <cmd>; it finds the first bad revision automatically.",
      /* display falls back to reason */
    },
  },
  {
    match: ["blame"],
    classification: "deny",
    message: {
      reason:
        "Refused: git blame. Run: jj file annotate <path> to show the change that last modified each line.",
      display: DISPLAY_REASONS.readOnly,
    },
  },
  {
    match: ["show"],
    classification: "deny",
    message: {
      reason: "Refused: git show. Run: jj show <rev> for the description plus diff.",
      display: DISPLAY_REASONS.readOnly,
    },
  },
  {
    match: ["clean", "-fd"],
    classification: "special",
    message: {
      reason:
        "Refused: git clean -fd; Jujutsu has no untracked state to clean. Inspect with jj status, then delete the files yourself with rm.",
      /* display falls back to reason */
    },
  },
  {
    match: ["restore"],
    classification: "deny",
    message: {
      reason:
        "Refused: git restore. Run: jj restore <paths> to restore from the parent, or jj restore --from <rev> <paths>.",
      display: DISPLAY_REASONS.reset,
    },
  },
  {
    match: ["init"],
    classification: "deny",
    message: {
      reason:
        "Refused: git init. This is already a Jujutsu workspace; there is nothing to initialise. To create a new Jujutsu repo elsewhere, run: jj git init <directory>.",
      /* display falls back to reason */
    },
  },
  {
    match: ["-C"],
    classification: "deny",
    message: {
      reason: "Refused: git -C <dir>. Run: jj -R <dir> <sub>, or cd <dir> first.",
      /* display falls back to reason */
    },
  },
  {
    match: ["config"],
    classification: "special",
    message: {
      reason:
        'Refused: git config; Jujutsu reads identity from its own config, not .git/config. Run: jj config set --user user.name "<name>", or jj config list.',
      /* display falls back to reason */
    },
  },
  {
    match: ["lfs"],
    classification: "special",
    message: {
      reason:
        "Refused: git lfs; Jujutsu has no LFS integration and the git binary fronts this subcommand. Fetch LFS objects with a plain Git checkout outside this workspace.",
      /* display falls back to reason */
    },
  },
];

/**
 * `docs/14` §R3–R5: bare `git`, `git --version` and any unrecognised subcommand
 * share one reason. A `git` invocation must never fall through to allow merely
 * because its subcommand is unknown.
 */
export const GENERIC_FALLBACK: Message = {
  reason:
    "Refused: this is a Jujutsu workspace and git is not used here. Run: jj help for the command list, or jj log for history with change IDs.",
  /* display falls back to reason */
};

/**
 * `SPEC.md` §5.7 / `docs/14` §R9: a destructive verb whose resolved path names
 * the exact component `.git` or `.jj`. `unresolvable` is the ask-never-allow
 * case for a path containing a shell expansion.
 */
export const DESTRUCTIVE: Readonly<Record<"git" | "jj" | "unresolvable", Message>> = {
  git: {
    reason:
      "Refused: this deletes .git, which is where Jujutsu keeps its commit objects — so it destroys the history, not just the Git plumbing, and jj cannot restore it. If you meant to stop using Git here, run jj git colocation disable instead.",
    display: DISPLAY_REASONS.destructive,
  },
  jj: {
    reason:
      "Refused: this deletes .jj, which holds the operation log — the record every jj undo depends on. Without it nothing is recoverable. To get back to a good state use jj op restore <opId> (list them with jj op log).",
    display: DISPLAY_REASONS.destructive,
  },
  unresolvable: {
    reason:
      "Refused: this deletes a computed path that resolves to .git or .jj. It cannot be checked before the command runs, and both are unrecoverable — .git holds Jujutsu's commits, .jj its operation log. Use a literal path if you mean it.",
    display: DISPLAY_REASONS.destructive,
  },
};

/**
 * `docs/14` §D6 / `SPEC.md` §5.7: `read`/`write`/`edit` into `.jj/**` or
 * `.git/**`. Writes are refused in both postures; reads are allowed and produce
 * no message.
 */
export const WRITE_PROTECTION: Readonly<Record<"jj" | "git", Message>> = {
  jj: {
    reason:
      "Refused: writing inside .jj corrupts the operation log and working-copy state. Read is allowed. To undo a bad operation run: jj op restore <opId> (list operations with jj op log).",
    display: DISPLAY_REASONS.writeProtected,
  },
  git: {
    reason:
      "Refused: writing inside .git corrupts the Git backend Jujutsu reads. Read is allowed. To undo a bad operation run: jj op restore <opId> (list operations with jj op log).",
    display: DISPLAY_REASONS.writeProtected,
  },
};

/**
 * The indirect/computed-program case: the invocation cannot be resolved, so it
 * asks and is never allowed. Re-running with the program named literally is the
 * only way forward.
 */
export const LOW_CONFIDENCE: Message = {
  reason:
    "This invocation cannot be resolved confidently (indirect or computed program). If it runs Git, replace it with the jj equivalent (run jj help). Otherwise re-run it with the program named literally.",
  display: DISPLAY_REASONS.lowConfidence,
};

/**
 * `docs/25` §2.2, the workspace rule: most `jj` subcommands need a workspace, and
 * outside one they exit with `There is no jj repo in "."`. When the user forced
 * Jujutsu, the guard refuses the call *before* it runs, so the model is told what
 * to do instead of spending a call on an error it cannot act on.
 */
export const JJ_NO_WORKSPACE: Message = {
  reason:
    "Refused: there is no Jujutsu workspace here, so this jj command would fail. Initialise one first with jj git init --colocate, then retry.",
  /* display falls back to reason */
};

/**
 * The same rule in a plain Git repository the adoption probe refused. Naming
 * `jj git init` here would be worse than useless — running it is exactly what the
 * probe exists to prevent — so the message sends the model back to Git.
 */
export const JJ_ADOPTION_REFUSED: Message = {
  reason:
    "Refused: jj cannot be used in this repository. Adopting it for Jujutsu was refused because jj would corrupt it, so use Git here instead.",
  /* display falls back to reason */
};

/**
 * Verbs that are read-only *in their listing form only* (`docs/14` §R6). The
 * always-read-only verbs — `status`, `log`, `diff`, `show`, `blame`,
 * `rev-parse`, `describe` — are deliberately absent: they have no mutating form
 * to distinguish, so they are read-only unconditionally and never need a form
 * check.
 */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "branch",
  "tag",
  "remote",
  "config",
  "stash",
]);

/**
 * For each read-only verb, the argument forms that keep it read-only
 * (`docs/14` §R6). An empty string denotes the bare invocation with no
 * arguments. Anything not positively listed here is treated as mutating — fail
 * closed, because the cost of a wrong allow is a silently rewritten repository.
 */
export const LISTING_FORMS: Readonly<Record<string, readonly string[]>> = {
  branch: ["", "-a", "-v", "--list"],
  tag: ["", "-l", "--list"],
  remote: ["-v", "show"],
  config: ["--get", "--get-all", "--list", "-l"],
  stash: ["list", "show"],
};

/** Every message this module ships, for the budget assertion and for tests. */
export const ALL_MESSAGES: readonly Message[] = [
  ...VERB_ROWS.map((row) => row.message),
  GENERIC_FALLBACK,
  ...Object.values(DESTRUCTIVE),
  ...Object.values(WRITE_PROTECTION),
  LOW_CONFIDENCE,
  JJ_NO_WORKSPACE,
  JJ_ADOPTION_REFUSED,
];

// Copy rule 2: every reason is ≤240 chars. Asserted at load so a future edit
// cannot silently break the budget. `docs/25` §5 states the longest is 234.
for (const message of ALL_MESSAGES) {
  if (message.reason.length > MAX_REASON_CHARS) {
    throw new Error(
      `dsh-jujutsu/messages: reason is ${message.reason.length} chars, over the ${MAX_REASON_CHARS}-char budget: ${message.reason}`,
    );
  }
}
