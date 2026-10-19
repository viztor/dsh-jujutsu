/**
 * The injection: what the model is told, and — more importantly — when it is
 * told nothing at all.
 *
 * The rule has to be in the prompt *before* the model's first Git command, which
 * is why it is a `section` rather than something fetched on demand. The state
 * changes between turns, which is why it is a `context`. And both must vanish
 * outside a `jj` workspace, because that is what makes the plugin invisible
 * everywhere else.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { applyContext } from "../src/context.ts";
import { resolveSettings } from "../src/settings.ts";
import { clearWorkspaceState, setWorkspaceState } from "../src/state.ts";
import { fakeHarness } from "./helpers.ts";

const SETTINGS = resolveSettings({});

function harnessWithContext() {
  const harness = fakeHarness();
  applyContext(harness.ctx, SETTINGS);
  return harness;
}

/** The assembly context a provider receives — only `agent` is read. */
const forSession = (id: string) => ({ agent: { session: { id } } });

beforeEach(() => {
  clearWorkspaceState();
});

describe("the rule", () => {
  it("is a section placed at TOOL_BASH", () => {
    const h = harnessWithContext();
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    expect(section).toBeDefined();
    // The same slot the bash tool uses for its own section, so the rule sits
    // with the tool it constrains.
    expect(section?.order).toBe(1000);
  });

  it("says the four things the model gets wrong", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", {
      vcs: "jj",
      root: "/repo",
      kind: "jj-colocated",
      jjHunk: true,
    });
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    const text = section?.text(forSession("s1")) ?? "";
    expect(text).toContain("Jujutsu (jj)");
    expect(text).toContain("working copy @ is always a commit");
    expect(text).toContain("change ID");
    expect(text).toContain("Bookmarks");
  });

  it("is empty outside a jj workspace", () => {
    // The whole reason the plugin is invisible in a plain Git repo: the provider
    // returns '', and an empty contribution costs nothing.
    const h = harnessWithContext();
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    expect(section?.text(forSession("s1"))).toBe("");
  });

  it("is empty for a caller with no agent", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "jj", root: "/repo", kind: "jj-native", jjHunk: false });
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    expect(section?.text({})).toBe("");
  });
});

describe("the state", () => {
  it("is a runtime context at the next free order", () => {
    const h = harnessWithContext();
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    expect(context).toBeDefined();
    // CONTEXT_ORDERS reserves 110, 115 and 120; 130 is the next free slot.
    expect(context?.order).toBe(130);
  });

  it("renders the root, the layout and the hunk availability", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", {
      vcs: "jj",
      root: "/repo",
      kind: "jj-colocated",
      changeId: "nsosovxq",
      jjHunk: true,
    });
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const text = context?.text(forSession("s1")) ?? "";
    expect(text).toContain("Workspace root: /repo");
    expect(text).toContain("colocated with Git");
    expect(text).toContain("nsosovxq");
    expect(text).toContain("jj-hunk available");
  });

  it("distinguishes a native workspace", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "jj", root: "/repo", kind: "jj-native", jjHunk: false });
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const text = context?.text(forSession("s1")) ?? "";
    expect(text).toContain("native jj, no .git");
    expect(text).toContain("jj-hunk not installed");
  });

  it("is empty outside a jj workspace", () => {
    const h = harnessWithContext();
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    expect(context?.text(forSession("s1"))).toBe("");
  });
});

describe("the budget", () => {
  it("keeps the rule under the documented word count", () => {
    // docs/25 §1.4: the section is 68 words and the rendered context 21, against
    // a combined ~200-word budget. A future edit that doubles the rule would
    // otherwise ship silently.
    const h = harnessWithContext();
    setWorkspaceState("s1", {
      vcs: "jj",
      root: "/repo",
      kind: "jj-colocated",
      changeId: "nsosovxq",
      jjHunk: true,
    });
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const words =
      (section?.text(forSession("s1")) ?? "").split(/\s+/).filter(Boolean).length +
      (context?.text(forSession("s1")) ?? "").split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(120);
  });
});

describe("a directory with no version control", () => {
  it("tells the model, and prefers jj", () => {
    // The case the plugin used to be silent about: no `.jj`, no `.git`, and an
    // agent that would otherwise work for an hour without mentioning it.
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "none", root: "/work" });
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const text = context?.text(forSession("s1")) ?? "";
    expect(text).toContain("Version control: none");
    expect(text).toContain("jj git init");
  });

  it("suggests plain git when jj is not preferred", () => {
    const harness = fakeHarness();
    applyContext(harness.ctx, resolveSettings({ preferJj: false }));
    setWorkspaceState("s1", { vcs: "none", root: "/work" });
    const context = harness.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const text = context?.text(forSession("s1")) ?? "";
    expect(text).toContain("git init");
    expect(text).not.toContain("jj git init");
  });

  it("says nothing when the alert is off", () => {
    const harness = fakeHarness();
    applyContext(harness.ctx, resolveSettings({ alertUninitialised: false }));
    setWorkspaceState("s1", { vcs: "none", root: "/work" });
    const context = harness.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    expect(context?.text(forSession("s1"))).toBe("");
  });

  it("does not state the jj rule where there is no jj", () => {
    // The rule is about driving `jj`. Asserting it in a directory with no
    // Jujutsu would be false.
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "none", root: "/work" });
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    expect(section?.text(forSession("s1"))).toBe("");
  });
});

describe("a plain Git repository", () => {
  it("reports Git and says the guard is inactive", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "git", root: "/repo" });
    const context = h.prompt.contexts.find((c) => c.name === "jujutsu:workspace");
    const text = context?.text(forSession("s1")) ?? "";
    expect(text).toContain("Version control: Git");
    expect(text).toContain("guard is inactive");
  });

  it("still does not state the jj rule", () => {
    const h = harnessWithContext();
    setWorkspaceState("s1", { vcs: "git", root: "/repo" });
    const section = h.prompt.sections.find((s) => s.name === "jujutsu:bash-policy");
    expect(section?.text(forSession("s1"))).toBe("");
  });
});

describe("adoption is reported, not assumed", () => {
  it("says the repository was adopted, and what follows from it", () => {
    // The one workflow constraint the plugin can state. A Git user who never
    // opted into Jujutsu is downstream of everything the agent does, so the
    // prompt has to name the constraint rather than leave it to inference.
    const h = harnessWithContext();
    setWorkspaceState("s1", {
      vcs: "jj",
      root: "/r",
      kind: "jj-colocated",
      adoption: { status: "adopted" },
    });
    const text =
      h.prompt.contexts.find((c) => c.name === "jujutsu:workspace")?.text(forSession("s1")) ?? "";
    expect(text).toContain("Adopted:");
    expect(text).toContain("do not rewrite published history");
    // The ordinary facts are still there: adoption adds a line, it does not
    // replace the workspace description.
    expect(text).toContain("Workspace root: /r");
  });

  it("says why a plain Git repo could not be adopted", () => {
    // "jj is not available" on its own reads as a missing install, and the
    // model would have no way to tell a user what to change.
    const h = harnessWithContext();
    setWorkspaceState("s1", {
      vcs: "git",
      root: "/r",
      adoption: { status: "blocked", blocker: "lfs", evidence: "/r/.gitattributes" },
    });
    const text =
      h.prompt.contexts.find((c) => c.name === "jujutsu:workspace")?.text(forSession("s1")) ?? "";
    expect(text).toContain("cannot be used here");
    expect(text).toContain("LFS");
    // The guard is still inactive there, and saying so is what stops the model
    // assuming a protection that is not in force.
    expect(text).toContain("guard is inactive");
  });
});
