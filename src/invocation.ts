/**
 * The invocation resolver — the ported engine.
 *
 * This module is a *verbatim* copy of `scripts/probe-invocation.mjs`: 790 lines
 * of dense shell-lexing exercised against a 64-command corpus with **0 false
 * positives** and 10 flagged false negatives (`docs/21-guard-evasion.md`).
 *
 * **The port carried `// @ts-nocheck` and no longer does.** The order was
 * deliberate: port byte-identical, prove the corpus (see `test/parse.test.ts`),
 * *then* annotate — doing both at once would make a corpus failure impossible to
 * attribute. The annotations went in as their own pass, with the corpus green
 * before and after, and the only edits that are not types are guards for
 * `noUncheckedIndexedAccess` on indexed reads the code had already established
 * were in range.
 *
 * The types here are the *internal* shapes. `parse.ts` remains the typed public
 * surface, and the corpus remains the behavioural contract.
 *
 * @module dsh-jujutsu/invocation
 */

import type { Invocation } from "./parse.ts";

/**
 * The invocation resolver — ported verbatim from `scripts/probe-invocation.mjs`.
 *
 * The rule, from `docs/15-verb-mapping.md` §4:
 *
 *   Resolve the *invoked program*, never scan for the `git` token: split on
 *   shell operators, strip leading `VAR=value` and wrapper words (`env`,
 *   `command`, `nohup`, `time`, `sudo`, `exec`, `nice`), recurse into
 *   `sh -c` / `bash -c` / `eval` bodies and `$()` / backticks, then DENY only
 *   if the basename is exactly `git`.
 *
 * This is a *probe*, not production code. It is deliberately readable and
 * deliberately honest about the cases it cannot resolve: whenever it guesses,
 * it lowers `confidence` to `'low'` and says why in `notes`.
 *
 * ── What it deliberately does NOT attempt ────────────────────────────────────
 *
 *  - No real shell grammar. It does not implement `${x:-y}` word splitting,
 *    arithmetic evaluation, process substitution `<(...)`, heredocs, `<<<`,
 *    `coproc`, or here-strings. A heredoc body is treated as ordinary words,
 *    which can both miss a command and invent one.
 *  - No expansion. `$g`, `${g}`, `$1`, `$@` are opaque: the parser never
 *    substitutes a value, it only notes that the program is computed at run
 *    time.
 *  - No alias/function *resolution*. It records that a function named `git` was
 *    defined in the same command text and refuses to call the result a Git
 *    invocation (unless the call site used `command git` or `\git`, which
 *    genuinely bypass shell functions).
 *  - No filesystem. `./scripts/commit.sh`, `make commit`, `npm run release`,
 *    `python3 foo.py` are reported as *opaque* — the file/target/script body is
 *    never read.
 *  - No PATH resolution. `git` means "the program that a shell would find under
 *    the name `git`", not a specific inode. Two Gits exist on this machine
 *    (`/opt/homebrew/bin/git`, `/usr/bin/git`); both resolve to `git`.
 *  - No globbing, no `set -e` semantics, no `trap`/`DEBUG`, no `shopt`.
 *  - No Windows specifics beyond stripping a trailing `.exe` from the basename.
 *  - No size or time guard: a pathological input can make it slow (the
 *    substitution scanner is O(n·depth), not exponential, but it is untuned).
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 *
 *   classifyInvocation(command) -> {
 *     programs:       string[]   resolved program basenames, in first-seen order
 *     gitInvocations: string[]   raw command text of each fragment whose head
 *                                program resolves to `git`
 *     confidence:     'high' | 'low'   'low' iff something was unresolvable
 *     notes:          string[]   'unresolved: …' lowers confidence;
 *                                'info: …' and 'recursed: …' do not
 *   }
 *
 * CLI:
 *   node scripts/probe-invocation.mjs              # markdown table for CORPUS
 *   node scripts/probe-invocation.mjs --json       # same, as JSON
 *   node scripts/probe-invocation.mjs -c 'git x'   # classify one command
 */

const MAX_DEPTH = 5;

/* ── vocabulary ──────────────────────────────────────────────────────────── */

// Words that exec the rest of the fragment. `xargs` is here too, but it is
// flagged low-confidence because what it execs depends on stdin (docs/15 §4
// argues for leaving `xargs` alone entirely; see docs/21 §b for the trade-off).
const WRAPPERS = new Set([
  'env', 'command', 'nohup', 'time', 'sudo', 'doas', 'exec', 'nice',
  'stdbuf', 'setsid', 'ionice', 'chrt', 'builtin', 'xargs',
]);

// Flags that consume the *next* token, per wrapper. Getting this wrong shifts
// the head by one and invents a program, so it is per-wrapper, not global.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C',
    '--close-from', '-h', '--host', '-r', '--role', '-t', '--type',
    '-U', '--other-user', '-D', '--chdir']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set([]),
  nohup: new Set([]),
  command: new Set([]),
  builtin: new Set([]),
  exec: new Set(['-a']),
  setsid: new Set([]),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  ionice: new Set(['-c', '-n', '-p']),
  chrt: new Set(['-p', '-T', '-P', '-R', '-O', '-D', '-H']),
  xargs: new Set(['-I', '-i', '-n', '--max-args', '-P', '--max-procs', '-s',
    '--max-chars', '-a', '--arg-file', '-E', '-e', '-d', '--delimiter', '-L',
    '--max-lines', '-o', '--open-tty', '-x', '--process-slot-var']),
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish',
  'csh', 'tcsh', 'busybox']);

// Reserved words that can precede a command without being one.
const RESERVED_SKIP = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif',
  'fi', 'while', 'until', 'do', 'done', '[[', ']]', 'function', 'coproc']);
// Reserved words whose *fragment* is a header, not a command list.
const RESERVED_SKIP_FRAGMENT = new Set(['for', 'case', 'select']);

const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs',
  'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'rscript', 'osascript', 'pwsh',
  'powershell']);

// Programs that dispatch to commands defined outside the command text.
const OPAQUE_RUNNERS = new Set(['make', 'just', 'task', 'npm', 'pnpm', 'yarn',
  'npx', 'pnpx', 'bunx', 'cargo', 'rake', 'gradle', 'mvn', 'docker', 'podman',
  'poetry', 'uv', 'hatch', 'tox', 'bazel', 'buck2', 'ninja', 'cmake', 'xcodebuild',
  'source', '.']);

const SCRIPT_EXT =
  /\.(sh|bash|zsh|ksh|fish|csh|py|rb|pl|php|js|mjs|cjs|ts|tsx|ps1|bat|cmd|exe)$/i;

/* ── types ───────────────────────────────────────────────────────────────── */

/** One word token, as the tokenizer produces it. */
export interface RawWordToken {
  readonly value: string;
  readonly quoted: boolean;
  readonly escaped: boolean;
  readonly start: number;
  readonly end: number;
}

/** One shell operator token. */
export interface RawOpToken {
  readonly op: string;
}

/**
 * The tokenizer emits both shapes into one array. Internal helpers that read
 * `.value` directly are safe because every call site has already split on
 * operators — `splitFragments` does that before anything else looks at a token.
 */
export type RawToken = RawWordToken | RawOpToken;

/**
 * One command fragment: the tokens of a single command, plus the raw text they
 * were cut from (substitutions already replaced).
 */
export interface Fragment {
  /**
   * Word tokens only. `splitFragments` consumes every operator to cut the
   * fragment, so nothing downstream has to re-check for one.
   */
  readonly tokens: RawWordToken[];
  readonly raw: string;
}

/** The mutable accumulator threaded through one analysis. */
export interface AnalyzerState {
  programs: string[];
  gitInvocations: string[];
  notes: string[];
  low: boolean;
  functionDefs: Set<string>;
}

/** One row of the built-in corpus. */
export interface CorpusEntry {
  readonly cmd: string;
  readonly truth: 'git' | 'none';
  readonly what: string;
  readonly method?: string | undefined;
  readonly acceptable?: boolean | undefined;
  /** Free-text note on why a row is in the corpus. */
  readonly why?: string | undefined;
}

const SUB = (id: number) => `\u0000SUB${id}\u0000`;
const SUB_RE = /^\u0000SUB(\d+)\u0000$/;
const FUNC_SENTINEL = '\u0000FUNCDEF\u0000';

/* ── small helpers ───────────────────────────────────────────────────────── */

const basename = (p: string) => {
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
};

const stripParens = (s: string) => s.replace(/^\(+/, '').replace(/\)+$/, '');

const isAssignment = (v: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(v);

/** `git status` → `` `git status` ``, but survives embedded backticks. */
function code(s: string) {
  return s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`';
}

/* ── tokenizer ───────────────────────────────────────────────────────────── */

/**
 * Split into words and control operators, honouring single quotes, double
 * quotes, backslash escapes, `\`-newline continuations and `#` comments.
 * Offsets are recorded so a fragment's raw source can be recovered verbatim.
 * `(` and `)` are NOT operators: keeping them inside the word means `(git`
 * tokenises as one word whose basename is still `git`, and `git()` stays one
 * word that no longer looks like a program.
 */
/**
 * Split a command fragment into argv tokens, respecting quotes.
 * Exported so `verbs.ts` reuses this tokenizer instead of writing a second one.
 */
export function tokenize(text: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = text.length;
  let value = '', quoted = false, escaped = false, started = false, start = -1;

  const flush = (end: number) => {
    if (started) tokens.push({ value, quoted, escaped, start, end });
    value = ''; quoted = false; escaped = false; started = false; start = -1;
  };
  const begin = () => { if (!started) { started = true; start = i; } };

  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }          // continuation
      if (i + 1 < n) { begin(); value += text[i + 1]; escaped = true; i += 2; continue; }
      i++; continue;
    }

    if (c === "'") {
      begin();
      const end = text.indexOf("'", i + 1);
      value += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      quoted = true;
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (c === '"') {
      begin();
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n && '"\\$`'.includes(text[i + 1] as string)) {
          value += text[i + 1]; i += 2; continue;
        }
        value += text[i]; i++;
      }
      i++; // closing quote (or EOF)
      quoted = true;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') { flush(i); i++; continue; }
    if (c === '\n') { flush(i); tokens.push({ op: '\n' }); i++; continue; }

    if (c === '#' && !started) {                    // comment to end of line
      while (i < n && text[i] !== '\n') i++;
      continue;
    }

    if (c === ';') { flush(i); tokens.push({ op: ';' }); i++; continue; }
    if (c === '&' && text[i + 1] === '>') { begin(); value += '&>'; i += 2; continue; }
    if (c === '&') {
      flush(i);
      if (text[i + 1] === '&') { tokens.push({ op: '&&' }); i += 2; }
      else { tokens.push({ op: '&' }); i++; }
      continue;
    }
    if ((c === '>' || c === '<') && text[i + 1] === '&') {
      begin(); value += c + '&'; i += 2; continue;      // `2>&1`, `<&0`
    }
    if (c === '|') {
      flush(i);
      if (text[i + 1] === '|') { tokens.push({ op: '||' }); i += 2; }
      else if (text[i + 1] === '&') { tokens.push({ op: '|&' }); i += 2; }
      else { tokens.push({ op: '|' }); i++; }
      continue;
    }

    begin();
    value += c;
    i++;
  }
  flush(n);
  return tokens;
}

function splitFragments(tokens: RawToken[], replaced: string): Fragment[] {
  const frags: Fragment[] = [];
  let cur: RawWordToken[] = [];
  const emit = () => {
    if (!cur.length) return;
    // Every operator was consumed by the loop below, so `cur` holds words only.
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (first === undefined || last === undefined) return;
    frags.push({ tokens: cur, raw: replaced.slice(first.start, last.end).trim() });
    cur = [];
  };
  for (const t of tokens) {
    if ('op' in t) { emit(); continue; }
    cur.push(t);
  }
  emit();
  return frags;
}

/* ── substitution extraction ─────────────────────────────────────────────── */

function findMatchingParen(text: string, start: number) {
  let depth = 1, i = start, quote = null;   // caller is just past the `(`
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && quote === null) { quote = "'"; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findArithEnd(text: string, start: number) {
  let depth = 0, i = start;
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      if (depth === 0 && text[i + 1] === ')') return i + 2;
      depth--;
    }
  }
  return text.length;
}

function findBacktickEnd(text: string, start: number) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') return i;
  }
  return -1;
}

/**
 * Pull every `$(…)` and `` `…` `` body out of `text`, leaving a sentinel in its
 * place, and return the bodies for recursive analysis. Single-quoted regions
 * are literal (bash does not substitute inside them); `$((…))` is arithmetic
 * and is left alone.
 */
function extractSubstitutions(text: string) {
  const bodies = [];
  let out = '';
  let i = 0;
  const n = text.length;
  let quote = null;

  while (i < n) {
    const c = text[i];

    if (quote === "'") { out += c; if (c === "'") quote = null; i++; continue; }
    if (c === '\\' && quote !== "'") { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === "'" && quote === null) { quote = "'"; out += c; i++; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; out += c; i++; continue; }

    if (c === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {                       // arithmetic, skip
        const end = findArithEnd(text, i + 3);
        out += text.slice(i, end); i = end; continue;
      }
      const end = findMatchingParen(text, i + 2);
      if (end === -1) {
        bodies.push({ kind: 'unterminated `$(`', body: text.slice(i + 2) });
        out += text.slice(i); i = n; continue;
      }
      const body = text.slice(i + 2, end);
      bodies.push({ kind: 'command substitution `$(…)`', body, raw: text.slice(i, end + 1) });
      out += SUB(bodies.length - 1);
      i = end + 1;
      continue;
    }

    if (c === '`') {
      const end = findBacktickEnd(text, i + 1);
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      bodies.push({ kind: 'backtick substitution', body, raw: text.slice(i, (end === -1 ? n : end) + 1) });
      out += SUB(bodies.length - 1);
      i = end === -1 ? n : end + 1;
      continue;
    }

    out += c;
    i++;
  }
  return { text: out, bodies };
}

/** Named `$VAR` / `${VAR}` references outside single quotes. */
function findVariableRefs(text: string) {
  const found = new Set();
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && quote !== "'") { quote = quote === null ? "'" : null; continue; }
    if (c === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
    if (c !== '$') continue;
    const rest = text.slice(i);
    let m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
    if (m) { found.add('${' + m[1] + '}'); continue; }
    m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (m) { found.add('$' + m[1]); continue; }
    m = /^\$([@*])/.exec(rest);
    if (m) { found.add('$' + m[1]); continue; }
  }
  return [...found];
}

/* ── function definitions ────────────────────────────────────────────────── */

/**
 * Replace `name() { … }` and `function name { … }` *headers* with a sentinel
 * and report the names. The body is then skipped (see analyzeFragment): a
 * definition is inert, so flagging `git` inside one would be a false positive.
 * The names are remembered so a later `git status` in the same command text can
 * be reported as ambiguous rather than as a Git invocation.
 */
function maskFunctionDefs(text: string) {
  const names: string[] = [];
  let out = text;
  out = out.replace(
    /(^|[;&|\n])\s*function\s+([A-Za-z_][A-Za-z0-9_.-]*)/g,
    (_m, p1, name) => { names.push(name); return p1 + ' ' + FUNC_SENTINEL; },
  );
  out = out.replace(
    /(^|[;&|\n])\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\(\s*\)/g,
    (_m, p1, name) => { names.push(name); return p1 + ' ' + FUNC_SENTINEL; },
  );
  return { text: out, names };
}

/* ── fragment analysis ───────────────────────────────────────────────────── */

function skipFlags(tokens: RawWordToken[], i: number, wrapper: string) {
  const takesValue = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) return i;
    const v = token.value;
    if (v === '--') return i + 1;
    if (!v.startsWith('-')) return i;
    if (takesValue.has(v)) { i += 2; continue; }
    i += 1;                                   // plain flag or `-n10` style
  }
  return i;
}

/** Index of the `-c` flag for a shell invocation, or -1. */
function findDashC(tokens: RawWordToken[], from: number) {
  for (let j = from; j < tokens.length; j++) {
    const token = tokens[j];
    if (token === undefined) return -1;
    const v = token.value;
    if (v === '--') return -1;
    if (!v.startsWith('-')) return -1;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) return j;
  }
  return -1;
}

function record(state: AnalyzerState, prog: string, raw: string, isGit: boolean) {
  if (!prog || prog === FUNC_SENTINEL) return;
  if (!state.programs.includes(prog)) state.programs.push(prog);
  const shown = String(raw)
    .replace(/\u0000SUB\d+\u0000/g, '$(…)')
    .replace(new RegExp(FUNC_SENTINEL, 'g'), 'function')
    .trim();
  if (isGit && !state.gitInvocations.includes(shown)) state.gitInvocations.push(shown);
}

function analyzeFragment(frag: Fragment, state: AnalyzerState, depth: number) {
  const { tokens, raw } = frag;
  let i = 0;
  let functionBypassed = false;

  /* strip reserved words, assignments and wrappers */
  for (;;) {
    if (i >= tokens.length) return;
    const t = tokens[i];
    if (t === undefined) return;
    const v = t.value;
    if (v === '') { i++; continue; }

    if (RESERVED_SKIP_FRAGMENT.has(v)) {
      state.low = true;
      state.notes.push(`unresolved: control-flow keyword \`${v}\` — this fragment is a header; any command inside it is not analyzed`);
      return;
    }
    if (RESERVED_SKIP.has(v)) {
      state.notes.push(`info: reserved word \`${v}\` skipped`);
      i++; continue;
    }
    if (/^[0-9]*(>>?|<<?|<>)$/.test(v) || /^&>>?$/.test(v)) { i += 2; continue; } // `> file`: operator + target
    if (/^[0-9]*[<>]/.test(v) || /^\d+$/.test(v)) { i++; continue; }   // self-contained redirection (`>f`, `2>&1`)
    if (isAssignment(v) && !t.quoted) {
      if (/^PATH(\[[^\]]*\])?\+?=/.test(v)) {
        state.low = true;
        state.notes.push('unresolved: `PATH` is reassigned in this command text — program resolution may change');
      }
      i++; continue;
    }

    const base = basename(v);
    if (base === 'alias' || base === 'unalias' || base === 'shopt') {
      state.low = true;
      state.notes.push(`unresolved: \`${base}\` changes shell name resolution (aliases/options) which is not modeled`);
      record(state, base, raw, false);
      return;
    }
    if (base === 'set' && tokens.slice(i + 1).some((x) => x.value === '-o')) {
      state.low = true;
      state.notes.push('unresolved: `set -o` changes shell options');
      record(state, base, raw, false);
      return;
    }
    if (WRAPPERS.has(base)) {
      if (base === 'command') functionBypassed = true;
      if (base === 'xargs') {
        state.low = true;
        state.notes.push('unresolved: `xargs` — the program it runs is assembled from stdin; detection here is best-effort');
      }
      i = skipFlags(tokens, i + 1, base);
      continue;
    }
    if (base === 'eval') {
      const body = tokens.slice(i + 1).map((x) => x.value).join(' ');
      if (!body.trim()) { state.low = true; state.notes.push('unresolved: `eval` with an empty body'); return; }
      state.notes.push(`recursed: \`eval\` body → ${code(body.trim())}`);
      analyze(body, state, depth + 1);
      return;
    }
    break;
  }

  const head = tokens[i];
  if (head === undefined) return;
  let hv = stripParens(head.value);
  if (hv === '') return;

  if (SUB_RE.test(hv)) {
    state.low = true;
    state.notes.push('unresolved: command substitution in program position — the program name is computed at run time');
    return;
  }
  if (hv.includes('\u0000SUB')) {
    state.low = true;
    state.notes.push(`unresolved: command substitution inside the word \`${hv.replace(/\u0000SUB\d+\u0000/g, '$(…)')}\``);
    return;
  }
  if (hv.startsWith('$')) {
    state.low = true;
    state.notes.push(`unresolved: variable expansion in program position: \`${hv}\``);
    return;
  }
  if (/^[0-9]*[<>]/.test(hv) || /^\d+$/.test(hv)) return;   // redirection / fd noise
  if (hv === FUNC_SENTINEL) {
    state.notes.push('unresolved: shell function definition — body not analyzed (a definition alone invokes nothing)');
    return;
  }

  const prog = basename(hv).replace(/\.exe$/i, '');
  const shadowed = state.functionDefs.has(prog) && !functionBypassed && !head.escaped;

  /* shells: recurse into `-c` bodies, otherwise treat the file as opaque */
  if (SHELLS.has(prog)) {
    record(state, prog, raw, false);
    const ci = findDashC(tokens, i + 1);
    const flagToken = ci === -1 ? undefined : tokens[ci];
    const bodyToken = ci === -1 ? undefined : tokens[ci + 1];
    if (flagToken !== undefined && bodyToken !== undefined) {
      const body = bodyToken.value;
      state.notes.push(`recursed: \`${prog} ${flagToken.value}\` body → ${code(body.trim())}`);
      analyze(body, state, depth + 1);
    } else if (tokens.slice(i + 1).some((t) => !t.value.startsWith('-'))) {
      state.low = true;
      state.notes.push(`unresolved: \`${prog}\` runs a script file — contents not read`);
    }
    return;
  }

  /* find/xargs style: the token after -exec is a program by definition */
  if (prog === 'find') {
    record(state, prog, raw, false);
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (token === undefined) break;
      const v = token.value;
      if (v === '-exec' || v === '-execdir' || v === '-ok' || v === '-okdir') {
        const nx = tokens[j + 1];
        if (nx) {
          const p = basename(stripParens(nx.value)).replace(/\.exe$/i, '');
          record(state, p, raw, p === 'git');
          state.notes.push(`info: \`find ${v}\` — program token \`${p}\` read statically`);
        }
      }
    }
    return;
  }

  /* opaque indirection: a real program name, but not the whole story */
  if (INTERPRETERS.has(prog)) {
    record(state, prog, raw, false);
    state.low = true;
    const inline = tokens.slice(i + 1).find((t) => /^-[A-Za-z]*[ce]$/.test(t.value));
    state.notes.push(inline
      ? `unresolved: \`${prog} ${inline.value}\` — inline code is not analyzed`
      : `unresolved: \`${prog}\` runs a file whose contents are not analyzed`);
    return;
  }
  if (OPAQUE_RUNNERS.has(prog)) {
    record(state, prog, raw, false);
    state.low = true;
    state.notes.push(`unresolved: \`${prog}\` dispatches to a target defined outside the command text`);
    return;
  }
  if (SCRIPT_EXT.test(prog)) {
    record(state, prog, raw, false);
    state.low = true;
    state.notes.push(`unresolved: \`${prog}\` is a script file — contents not read`);
    return;
  }

  if (prog === 'git' && shadowed) {
    state.low = true;
    state.notes.push(`unresolved: \`${prog}\` is also defined as a shell function in this command text; the function runs, not the binary`);
    record(state, prog, raw, false);
    return;
  }

  record(state, prog, raw, prog === 'git');
}

/* ── driver ──────────────────────────────────────────────────────────────── */

function analyze(text: string, state: AnalyzerState, depth: number) {
  if (depth > MAX_DEPTH) {
    state.low = true;
    state.notes.push(`unresolved: recursion depth cap (${MAX_DEPTH}) reached — nested command text not analyzed`);
    return;
  }

  const { text: substituted, bodies } = extractSubstitutions(text);
  for (const b of bodies) {
    if (b.kind.includes('unterminated')) {
      state.low = true;
      state.notes.push('unresolved: unterminated command substitution');
      continue;
    }
    state.notes.push(`recursed: ${b.kind} → ${code(b.body.trim())}`);
    analyze(b.body, state, depth + 1);
  }

  for (const v of findVariableRefs(substituted)) {
    state.notes.push(`info: variable expansion \`${v}\` in arguments — does not change the program`);
  }

  const masked = maskFunctionDefs(substituted);
  for (const name of masked.names) {
    state.low = true;
    state.functionDefs.add(name);
    state.notes.push(`unresolved: shell function definition \`${name}\` — later calls to that name are ambiguous`);
  }

  for (const frag of splitFragments(tokenize(masked.text), masked.text)) {
    analyzeFragment(frag, state, depth);
  }
}

/**
 * Classify one command string.
 *
 * @param command - the raw `bash` command text.
 * @returns every program the command resolves to, the `git` subset, a
 *   confidence, and why the resolver is unsure.
 */
export function classifyInvocation(command: string): Invocation {
  const state: AnalyzerState = { programs: [], gitInvocations: [], notes: [], low: false, functionDefs: new Set() };
  if (typeof command !== 'string' || command.trim() === '') {
    return { programs: [], gitInvocations: [], confidence: 'high', notes: ['info: empty command'] };
  }
  analyze(command, state, 0);
  return {
    programs: state.programs,
    gitInvocations: state.gitInvocations,
    confidence: state.low ? 'low' : 'high',
    notes: [...new Set(state.notes)],
  };
}

/* ── corpus ──────────────────────────────────────────────────────────────── */
/* `truth`: what a shell actually does when the string is executed as a
 * `bash -c` argument, established empirically with a logging `git` shim on
 * PATH (docs/21 §b) or, where a shim cannot observe it, marked `reasoned`. */

export const CORPUS: CorpusEntry[] = [
  // ── direct
  { cmd: 'git status', truth: 'git', what: 'Git runs; in a colocated repo it reads jj-maintained state' },
  { cmd: 'git commit -m x', truth: 'git', what: 'Git commits; jj then re-parents the working copy' },
  { cmd: 'git commit -m "x" && git push', truth: 'git', what: 'two Git invocations joined by &&' },
  { cmd: 'cd /tmp && git log', truth: 'git', what: 'Git outside the workspace' },
  { cmd: 'git status; jj log', truth: 'git', what: 'Git then jj; only the first is a violation' },
  { cmd: 'git --version', truth: 'git', what: 'Git with no subcommand' },
  { cmd: 'git status 2>&1 | tee log', truth: 'git', what: 'redirection and a pipe after the program' },
  // ── wrappers
  { cmd: 'command git status', truth: 'git', what: '`command` bypasses functions/aliases, still runs Git' },
  { cmd: 'env FOO=1 git push', truth: 'git', what: 'env execs Git with an extra variable' },
  { cmd: 'env -i git status', truth: 'git', what: 'clears the environment, but the default PATH still finds /usr/bin/git' },
  { cmd: 'nohup git fetch', truth: 'git', what: 'nohup execs Git' },
  { cmd: 'time git log', truth: 'git', what: 'the `time` keyword runs Git' },
  { cmd: 'sudo git status', truth: 'git', method: 'reasoned', what: 'sudo execs Git as root' },
  { cmd: 'exec git status', truth: 'git', what: 'exec replaces the shell with Git' },
  { cmd: 'nice git log', truth: 'git', what: 'nice execs Git' },
  { cmd: 'nice -n 10 git log', truth: 'git', what: '`-n 10` belongs to nice, not to the program' },
  { cmd: 'sudo -u root -- git push', truth: 'git', method: 'reasoned', what: 'sudo flag, value and `--` before the program' },
  { cmd: 'sudo sh -c \'git push\'', truth: 'git', method: 'reasoned', what: 'wrapper, then a nested shell body' },
  { cmd: 'env FOO=1 sh -c "git push"', truth: 'git', what: 'assignment, wrapper, nested shell' },
  { cmd: '\\git status', truth: 'git', what: 'backslash suppresses alias/function lookup, runs the binary' },
  { cmd: 'FOO=1 BAR=2 git status', truth: 'git', what: 'bare assignments prefix a simple command' },
  // ── path forms
  { cmd: '/usr/bin/git status', truth: 'git', method: 'reasoned', what: 'Apple Git at an absolute path' },
  { cmd: '/opt/homebrew/bin/git --version', truth: 'git', method: 'reasoned', what: 'Homebrew Git at an absolute path' },
  { cmd: './git status', truth: 'git', what: 'a relative path to a binary named git' },
  { cmd: 'git-lfs pull', truth: 'none', what: 'a different binary; it internally execs `git version` and `git rev-parse` (observed)' },
  { cmd: 'jj-hunk list', truth: 'none', what: 'a different binary again' },
  // ── nesting
  { cmd: "sh -c 'git commit'", truth: 'git', what: 'the nested body is the command' },
  { cmd: 'bash -lc "git push"', truth: 'git', what: 'login shell resets PATH, then the -c body runs Git' },
  { cmd: "zsh -c 'git status'", truth: 'git', what: 'zsh nested body' },
  { cmd: "bash -c 'echo hi; git status'", truth: 'git', what: 'two commands inside one nested body' },
  { cmd: "eval 'git log'", truth: 'git', what: 'eval parses its argument as a command' },
  { cmd: 'echo "v=$(git rev-parse HEAD)"', truth: 'git', what: 'substitution runs Git although the head program is echo' },
  { cmd: 'echo "v=`git rev-parse HEAD`"', truth: 'git', what: 'same, with backticks' },
  { cmd: 'echo "$(echo git)"', truth: 'none', what: 'a substitution that never invokes Git' },
  // ── indirection
  { cmd: 'g=git; $g status', truth: 'git', what: 'the program name comes from a variable' },
  { cmd: "alias gs='git status'; gs", truth: 'none', what: 'aliases are off in a non-interactive shell, so `gs` runs Ghostscript (which is on PATH) instead' },
  { cmd: "shopt -s expand_aliases; alias gs='git status'; gs", truth: 'none', what: 'still no alias expansion: with `;` the whole line is parsed before the alias exists' },
  { cmd: "shopt -s expand_aliases\nalias gs='git status'\ngs", truth: 'git', what: 'on separate input lines the alias is defined before use, and really runs Git' },
  { cmd: 'echo hi | xargs git add', truth: 'git', what: 'xargs execs Git on the piped input' },
  { cmd: "printf 'a\\n' | xargs -n1 git add", truth: 'git', what: 'xargs with a flag before the program' },
  { cmd: 'find . -exec git status \\;', truth: 'git', what: 'find -exec runs Git' },
  { cmd: 'git() { command git "$@"; }', truth: 'none', what: 'a definition is inert; nothing runs' },
  { cmd: 'git() { command git "$@"; }; git status', truth: 'git', what: 'the call runs the function, which reaches the real Git via `command`' },
  // ── scripts and other runners
  { cmd: 'make commit', truth: 'git', what: 'the Makefile target shells out to Git' },
  { cmd: './scripts/commit.sh', truth: 'git', what: 'the script shells out to Git' },
  { cmd: 'bash scripts/release.sh', truth: 'git', what: 'bash runs a file that shells out to Git' },
  { cmd: 'npm run release', truth: 'git', what: 'the package.json script shells out to Git' },
  { cmd: 'npm run git:check', truth: 'none', what: 'a script whose *name* contains git; its body is echo' },
  { cmd: 'python3 scripts/deploy.py', truth: 'git', what: 'the Python file spawns Git' },
  // ── other runtimes
  { cmd: 'python3 -c "import subprocess; subprocess.run([\'git\',\'status\'])"', truth: 'git', what: 'Python spawns Git' },
  { cmd: 'node -e "require(\'child_process\').execSync(\'git status\')"', truth: 'git', what: 'Node spawns Git' },
  { cmd: 'git -C /tmp status', truth: 'git', what: '`-C` changes directory; still Git' },
  // ── false-positive bait
  { cmd: 'echo "git commit -m x"', truth: 'none', what: 'a string argument' },
  { cmd: 'echo git', truth: 'none', what: 'git as an argument' },
  { cmd: 'grep -rn "git status" docs/', truth: 'none', what: 'a grep pattern' },
  { cmd: 'cat .git/config', truth: 'none', what: 'a path containing `.git`' },
  { cmd: 'jj git export', truth: 'none', what: 'jj subcommand; jj does not exec the git binary' },
  { cmd: 'jj git push', truth: 'none', what: 'jj subcommand' },
  { cmd: 'jj config get git.executable-path', truth: 'none', what: 'a jj subcommand whose argument is a config key containing the token git' },
  { cmd: '# git commit -m x', truth: 'none', what: 'a whole-line comment' },
  { cmd: 'echo hi # git commit', truth: 'none', what: 'a trailing comment' },
  { cmd: 'if git status; then echo ok; fi', truth: 'git', what: 'Git in an if-condition' },
  { cmd: '(git status)', truth: 'git', what: 'a subshell' },
  // ── the hole
  {
    cmd: 'rm -rf .git', truth: 'none', acceptable: false,
    what: 'deletes the Git directory; invokes no git program at all',
    why: 'destroys a colocated repo and is far more damaging than `git status`; a program-resolving guard cannot see it',
  },
];

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function verdictOf(entry: CorpusEntry, result: Invocation) {
  const detected = result.gitInvocations.length > 0;
  const real = entry.truth === 'git';
  if (real && detected) return 'correct';
  if (real && !detected) return 'false negative';
  if (!real && detected) return 'false positive';
  return 'correct';
}

function probeCell(result: Invocation) {
  if (result.gitInvocations.length === 0) return 'no git invocation';
  return 'git: ' + result.gitInvocations.map((s) => '`' + s + '`').join(', ');
}

function esc(s: string) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, '\\n');
}

function table(rows: readonly (readonly string[])[]) {
  const out: string[] = [];
  for (const r of rows) out.push('| ' + r.map(esc).join(' | ') + ' |');
  return out.join('\n');
}

/**
 * Run the whole corpus. Exported so the test can assert the port behaves
 * identically to the prototype rather than reimplementing the scoring.
 */
export function runCorpus() {
  const rows = [];
  const counts = { correct: 0, 'false negative': 0, 'false positive': 0 };
  let lowConfidence = 0;

  for (const entry of CORPUS) {
    const r = classifyInvocation(entry.cmd);
    const verdict = verdictOf(entry, r);
    counts[verdict]++;
    if (r.confidence === 'low') lowConfidence++;
    const acceptable = entry.acceptable === false ? 'NO' : 'yes';
    rows.push({
      entry, r, verdict, acceptable,
      cells: [
        code(entry.cmd),
        entry.what + (entry.method === 'reasoned' ? ' _(reasoned)_' : ''),
        probeCell(r),
        verdict,
        r.confidence,
        acceptable,
      ],
    });
  }
  return { rows, counts, lowConfidence };
}
