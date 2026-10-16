/**
 * The denial copy is a transcription of `docs/25-prompt-copy.md` §2, and
 * nothing checked it.
 *
 * `src/messages.ts` says so in its own header: every `reason` and every
 * `display` is "copied verbatim" from the document, and "if this file and
 * docs/25 ever disagree, the document wins". A claim like that is worth exactly
 * as much as the check behind it, and there was none — so a reworded string
 * would ship, the document would still describe the old one, and the next
 * person to compare them would not know which was authoritative.
 *
 * It matters more here than in most modules because the copy *is* the product:
 * the reason string is what the model reads when the guard refuses its call
 * (copy rule 1 — name the exact command), and the display string is what the
 * human reads in the approval prompt. A silently reworded denial is a behaviour
 * change with no diff in the document that specifies it.
 *
 * The document is the source of truth, so the check is verbatim membership, not
 * similarity. Three rows cannot be matched and are named explicitly below rather
 * than excused by a looser rule — a `toContain` on the first sentence would pass
 * for a string that had lost its `jj` replacement, which is the failure the copy
 * rules exist to prevent.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DESTRUCTIVE,
  DISPLAY_REASONS,
  GENERIC_FALLBACK,
  LOW_CONFIDENCE,
  VERB_ROWS,
  WRITE_PROTECTION,
} from "../src/messages.ts";

const DOC = "docs/25-prompt-copy.md";

/** The text between `start` and the next `end`, end exclusive. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
}

/** The middle column of every markdown table row in a section. */
function messageCells(section: string): Set<string> {
  const out = new Set<string>();
  for (const line of section.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) continue;
    const cells = row.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    out.add(cells[2] ?? "");
  }
  return out;
}

/** The rows of a §2 table whose last column is the character count. */
function countedRows(section: string): number {
  let rows = 0;
  for (const line of section.split("\n")) {
    const cells = line
      .trim()
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length >= 5 && /^\d+$/.test(cells[3] ?? "")) rows += 1;
  }
  return rows;
}

const document = readFileSync(DOC, "utf8");
const catalogue = between(document, "## 2. Denial message catalogue", "## 3. Tool descriptions");
const verbCopy = between(catalogue, "### 2.1", "### 2.2");
const specialCopy = between(catalogue, "### 2.2", "### 2.3");
const displayCopy = catalogue.slice(catalogue.indexOf("### 2.3"));

const copy = new Set([...messageCells(verbCopy), ...messageCells(specialCopy)]);
const displays = messageCells(displayCopy);

/** One transcribed string, with a stable name for the failure message. */
interface Entry {
  readonly label: string;
  readonly reason: string;
}

/** Every message-bearing string in `src/messages.ts`, labelled by its export. */
function entries(): Entry[] {
  return [
    ...VERB_ROWS.map((row) => ({
      label: `VERB_ROWS[${row.match.join(" ")}]`,
      reason: row.message.reason,
    })),
    { label: "GENERIC_FALLBACK", reason: GENERIC_FALLBACK.reason },
    ...Object.entries(DESTRUCTIVE).map(([key, message]) => ({
      label: `DESTRUCTIVE.${key}`,
      reason: message.reason,
    })),
    ...Object.entries(WRITE_PROTECTION).map(([key, message]) => ({
      label: `WRITE_PROTECTION.${key}`,
      reason: message.reason,
    })),
    { label: "LOW_CONFIDENCE", reason: LOW_CONFIDENCE.reason },
  ];
}

/**
 * The reasons that are **not** verbatim copies of `docs/25` §2, named one by one.
 *
 * Empty, and that is a resolved state rather than a placeholder. It once held
 * `DESTRUCTIVE.git`, `DESTRUCTIVE.jj` and `DESTRUCTIVE.unresolvable`: the module
 * had rewritten §2.2's destructive-path copy instead of transcribing it, and by
 * the module's own rule the document wins. The document turned out to be the
 * stale half — those three rows were the only ones in §2.2 without the
 * `Refused:` prefix every other denial carries, and `src/messages.ts` emits
 * `reason` verbatim as the refusal — so §2.2 was corrected to the shipped
 * strings and the debt is gone.
 *
 * The list stays as the mechanism for a genuine exception, and the check below
 * requires it to be **exactly** the set of reasons that fail verbatim
 * membership. That is what keeps an empty list meaningful: it asserts there are
 * no divergences, so a reworded string fails here as well as above, and a future
 * entry cannot be used to silence a mismatch that is not one.
 */
const NOT_VERBATIM: ReadonlySet<string> = new Set([]);

describe("the denial copy is the document's copy", () => {
  it("parses the catalogue it claims to parse", () => {
    // §2 states its own inventory: "43 rows" in §2.1, 7 in §2.2, 11
    // displayReason variants in §2.3. A reworded heading would empty a slice and
    // let every check below pass on nothing, which is the failure mode of a
    // parsing test.
    expect(countedRows(verbCopy)).toBe(43);
    expect(countedRows(specialCopy)).toBe(7);
    expect(countedRows(displayCopy)).toBe(11);
  });

  it("copies every reason verbatim from §2.1 or §2.2", () => {
    const missing = entries()
      .filter((entry) => !copy.has(entry.reason))
      .filter((entry) => !NOT_VERBATIM.has(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it("copies every displayReason verbatim from §2.3", () => {
    const missing = Object.entries(DISPLAY_REASONS)
      .filter(([, display]) => !displays.has(display))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("names exactly the rows it cannot match, rather than loosening the check", () => {
    // Two assertions, because either one alone can be gamed. A label that no
    // longer exists means the list has rotted into names nothing exports; a
    // declared exception that is in fact verbatim means the list is being used
    // to silence a mismatch that is not one. With the list empty this asserts
    // that *nothing* diverges — which is the point, not a vacuous pass.
    const all = entries();
    const labels = new Set(all.map((entry) => entry.label));
    expect([...NOT_VERBATIM].filter((label) => !labels.has(label))).toEqual([]);

    const divergent = all
      .filter((entry) => !copy.has(entry.reason))
      .map((entry) => entry.label)
      .sort();
    expect(divergent).toEqual([...NOT_VERBATIM].sort());
  });
});
