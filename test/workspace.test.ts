/**
 * Parsing `jj workspace list`.
 *
 * The listing is the only source that marks the current workspace, and its
 * shape moved under us: jj 0.47 appends `(current)` to the current row's name,
 * which put the `": "` separator after the annotation instead of after the
 * name. The old `^(\S+):` pattern then matched nothing, `jj_status` reported
 * `workspace: null`, and the integration suite caught it only because it runs
 * a real `jj`.
 *
 * Both shapes are pinned here so the next jj format change fails a unit test
 * instead of a coordination run.
 */

import { describe, expect, it } from "vitest";

import { currentWorkspaceNameFrom } from "../src/workspace.ts";

describe("currentWorkspaceNameFrom", () => {
  it("reads the annotated current row (jj 0.47+)", () => {
    const stdout = [
      "agent-a (current): .  tkxryxrv 83bd0baf (empty) (no description set)",
      "default: ../tmp.abc  tmqpnvqm 36849269 (empty) (no description set)",
    ].join("\n");
    expect(currentWorkspaceNameFrom(stdout)).toBe("agent-a");
  });

  it("reads the unannotated current row (earlier jj)", () => {
    const stdout = [
      "default: ../other  tmqpnvqm 36849269 (empty)",
      "agent-b: .  tkxryxrv 83bd0baf (empty)",
    ].join("\n");
    expect(currentWorkspaceNameFrom(stdout)).toBe("agent-b");
  });

  it("reads the default workspace when it is current", () => {
    expect(currentWorkspaceNameFrom("default (current): .  utrymwlu e3c2a8e5 (empty) base")).toBe(
      "default",
    );
  });

  it("returns undefined when no row is the working copy", () => {
    const stdout = [
      "agent-a: ../wa  tkxryxrv 83bd0baf (empty)",
      "default: ../root  tmqpnvqm 36849269 (empty)",
    ].join("\n");
    expect(currentWorkspaceNameFrom(stdout)).toBeUndefined();
  });

  it("ignores lines without a path column", () => {
    expect(currentWorkspaceNameFrom("")).toBeUndefined();
    expect(currentWorkspaceNameFrom("no separator here")).toBeUndefined();
    expect(currentWorkspaceNameFrom("agent-a (current): ../not-the-cwd")).toBeUndefined();
  });
});
