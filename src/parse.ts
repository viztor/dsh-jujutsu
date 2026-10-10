/**
 * The invocation resolver: what program does this command actually run?
 *
 * **This is a port, not a rewrite.** The engine lives in `invocation.ts`, which
 * is a byte-identical copy of `scripts/probe-invocation.mjs` — a file exercised
 * against a 64-command corpus with **0 false positives** and 10 flagged false
 * negatives (`docs/21-guard-evasion.md`). Its honesty about its own limits —
 * reporting `confidence: 'low'` instead of guessing — is the part worth
 * preserving, and that corpus is its regression suite.
 *
 * The rule, from `docs/15-verb-mapping.md` §4:
 *
 * > Resolve the *invoked program*, never scan for the `git` token: split on
 * > shell operators, strip leading `VAR=value` and wrapper words, recurse into
 * > `sh -c` / `eval` bodies and `$()` / backticks, then DENY only if the
 * > basename is exactly `git`.
 *
 * This was demonstrated live, the hard way: the probe built for
 * `docs/35-probe-results-live.md` matched sentinels with a naive
 * `command.includes(...)`, and promptly denied a `grep` whose *pattern text*
 * contained the sentinel. A token scan denies commands that merely mention the
 * token.
 *
 * @module dsh-jujutsu/parse
 */

import { tokenize as rawTokenize } from "./invocation.ts";

export { classifyInvocation } from "./invocation.ts";

/** What one command resolves to. */
export interface Invocation {
  /** Every program the command resolves to, in order. */
  readonly programs: readonly string[];
  /** The subset that is the `git` program. Empty means "not a Git invocation". */
  readonly gitInvocations: readonly string[];
  /** `low` when the resolver had to guess; policy treats that as a question, not an allow. */
  readonly confidence: "high" | "low";
  /** Why the resolver is unsure, for the log and for tests. */
  readonly notes: readonly string[];
}

/**
 * One word of a command, with the quoting and offset the tokenizer recorded.
 *
 * `value` is the word **after** quote removal and escape processing, which is
 * what matching needs. `quoted` matters to `paths.ts`, which must not treat a
 * quoted `$` as an expansion it can resolve.
 */
export interface WordToken {
  readonly value: string;
  readonly quoted: boolean;
  readonly escaped: boolean;
  readonly start: number;
  readonly end: number;
}

/** A shell operator: `;`, `&&`, `||`, `|`, `&`, `|&`, or a newline. */
export interface OpToken {
  readonly op: string;
}

export type Token = WordToken | OpToken;

/** Narrow a token to a word. */
export function isWord(token: Token): token is WordToken {
  return "value" in token;
}

/** Is this token the given operator? */
export function isOp(token: Token, op: string): boolean {
  return "op" in token && token.op === op;
}

/**
 * Tokenize with the engine's tokenizer, typed.
 *
 * The engine's own `RawToken` is the same union by another name. This wrapper is
 * where it becomes the named type the rest of `src/` narrows against — and it is
 * the reason `verbs.ts` and `paths.ts` share one tokenizer rather than each
 * growing their own.
 */
export function tokenize(text: string): readonly Token[] {
  return rawTokenize(text) as readonly Token[];
}
