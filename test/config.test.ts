/**
 * Every setting the schema declares must be read by something.
 *
 * `teachSkill` was the counter-example, and it shipped: it sat in `Config`, in
 * `Settings`, in the panel's field list and in the README's settings table as a
 * documented feature, and **no code read it**. Turning it off did nothing. The
 * panel drew a working control, the document promised behaviour, and the only
 * way to find out was to read all of `src/`.
 *
 * A schema is the one place this class of bug is mechanically detectable: the
 * field list is data, and so is the set of readers. So every field must either
 * be read by host code or be named below with a reason — an entry there is a
 * decision to ship a control that does nothing, which is sometimes right and
 * always worth stating.
 *
 * The reader set is deliberately narrow. `config.ts` declares every field and
 * `settings.ts` narrows every field, so counting either as a reader would make
 * the check pass for a field nothing consumes — which is exactly the bug.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const SCHEMA = join(SRC, "config.ts");

/** The field names `Config` declares, in source order. */
function declaredFields(): string[] {
  return [...readFileSync(SCHEMA, "utf8").matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): z/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** The host modules that could read a setting, in the order they are listed. */
function hostModules(): string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => file !== "config.ts" && file !== "settings.ts")
    .sort()
    .map((file) => join(SRC, file));
}

/**
 * The modules that read `field` off a resolved `Settings`.
 *
 * Three spellings, because all three are ordinary: `settings.guard`,
 * `settings["guard"]`, and `const { guard } = settings`. A comment that happens
 * to name `settings.<field>` counts too — no static check can tell prose from
 * code, and a documented reader is at least a reader someone intended.
 */
function readers(field: string): string[] {
  const direct = new RegExp(`settings\\.${field}\\b`);
  const indexed = new RegExp(`settings\\["${field}"\\]`);
  const destructured = new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=\\s*settings`);
  return hostModules()
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return direct.test(text) || indexed.test(text) || destructured.test(text);
    })
    .map((file) => basename(file));
}

/**
 * Fields the schema exposes but no host code reads.
 *
 * Empty on purpose. `teachSkill` was the one field in this state and it was a
 * bug, not a decision — `src/skill.ts` reads it now. Adding an entry is a
 * promise to a user about a control that does nothing, so it needs a reason.
 */
const SCHEMA_ONLY: ReadonlyMap<string, string> = new Map([]);

describe("every setting is read", () => {
  it("finds the fields the schema declares", () => {
    // A regex that matched nothing would make the check below vacuous, and a
    // vacuous guard reads as protection. `Config` has eleven fields.
    expect(declaredFields().length).toBeGreaterThanOrEqual(11);
  });

  it("is read by host code, or listed as schema-only with a reason", () => {
    const unread = declaredFields().filter(
      (field) => !SCHEMA_ONLY.has(field) && readers(field).length === 0,
    );
    expect(unread).toEqual([]);
  });

  it("keeps the schema-only list honest", () => {
    // A stale entry is worse than none: it would silently excuse the next field
    // that happened to reuse the name, and it reads as an approved decision.
    const declared = new Set(declaredFields());
    expect([...SCHEMA_ONLY.keys()].filter((field) => !declared.has(field))).toEqual([]);
    for (const [field, reason] of SCHEMA_ONLY) {
      expect(reason.length, field).toBeGreaterThan(20);
    }
  });
});
