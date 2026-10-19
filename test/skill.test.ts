/**
 * The `jujutsu` skill is where the manual lives, and its registration is a
 * contract rather than an implementation detail.
 *
 * `docs/28` §1.5 and `SPEC.md` §6 split the manual out of the system prompt: the
 * catalog carries one line and the body loads on demand. That split exists only
 * if the skill is actually registered — and `teachSkill`, the setting that
 * controls it, was declared in the schema, drawn by the panel and documented in
 * the README while **no code read it** (`test/config.test.ts` is the check that
 * closes that class).
 *
 * `src/skill.ts` declares the registry structurally, because
 * `@deepseek-ai/dsh-skill` is not a dependency, so the type system would not
 * catch a registration that drifted to another name, another source, or an empty
 * body. These tests pin the three facts the harness and the documents rely on.
 */

import { describe, expect, it } from "vitest";

import { resolveSettings } from "../src/settings.ts";
import { applySkill, SKILL_CONTENT, SKILL_DESCRIPTION } from "../src/skill.ts";
import { fakeHarness } from "./helpers.ts";

describe("the jj manual is a skill", () => {
  it("registers exactly one skill named jujutsu, with a description and content", () => {
    const harness = fakeHarness();
    applySkill(harness.ctx, resolveSettings({ teachSkill: true }));

    expect(harness.skills).toHaveLength(1);
    const skill = harness.skills[0];
    expect(skill?.name).toBe("jujutsu");
    // `bundled` is the harness's discriminator for a skill that ships with the
    // plugin rather than being read from a directory on disk; the catalog keys
    // on it, so a missing or different source changes how the skill is loaded.
    expect(skill?.source).toBe("bundled");
    // An empty description is a skill the model never routes to, and an empty
    // body is a catalog line that loads nothing. Both are silent failures: the
    // registration succeeds and the manual is simply absent.
    expect(skill?.description.trim().length).toBeGreaterThan(0);
    expect(skill?.content.trim().length).toBeGreaterThan(0);
  });

  it("registers nothing when teachSkill is off", () => {
    // Off must mean "the catalog never gains the line", not "the line is
    // registered and ignored" (`SPEC.md` §6): the second still spends the
    // catalog tokens the setting exists to save, so the control would be a lie.
    const harness = fakeHarness();
    applySkill(harness.ctx, resolveSettings({ teachSkill: false }));
    expect(harness.skills).toEqual([]);
  });

  it("does not throw when the harness has no skills service", () => {
    // A profile can mount the plugin without `skills` — `index.ts` lists it as
    // optional. The guard is the load-bearing half, so losing the manual must
    // degrade the manual and never the mount.
    const harness = fakeHarness({ skills: false });
    expect(() => applySkill(harness.ctx, resolveSettings({ teachSkill: true }))).not.toThrow();
    expect(harness.skills).toEqual([]);
  });

  it("stays a card, and sends the model to the binary for the rest", () => {
    // The body is paid for whenever it loads, so it must not grow back into a
    // manual: `jj help` is local, free and always matches the installed version.
    // Anything that can be discovered by running it does not belong here.
    expect(SKILL_CONTENT).toContain("jj help <subcommand>");
    // ~670 words today. The bound is headroom for a better sentence or two, not
    // room for the docs/15 verb catalogue to be pasted back in.
    const words = SKILL_CONTENT.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(800);
  });

  it("keeps the catalog line at or under the break-even length", () => {
    // `docs/32` §Q3: moving 38 words out of the injection saves ~57 tokens, and
    // the catalog line costs roughly one token per four characters. Break-even
    // is 214 characters, so a description that grows past it makes the split a
    // net cost — the opposite of its stated justification.
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(214);
    // It is a routing rule: the Git verbs a user says must survive every trim.
    for (const verb of ["commit", "branch", "rebase", "undo", "push"]) {
      expect(SKILL_DESCRIPTION).toContain(verb);
    }
  });
});
