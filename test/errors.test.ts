/**
 * The error shape the model sees, and the two guards the path parser leans on.
 *
 * `toolError` is small, but its `hint` behaviour is a contract: the value the
 * model reads is JSON, and `{ hint: undefined }` serialises to `{}` while being a
 * present key in the object. The spread is deliberate, and this pins it — every
 * failure the plugin reports should name the next command, so a missing hint
 * should be a missing key rather than a null one.
 */

import { describe, expect, it } from "vitest";

import { ErrorCode, toolError } from "../src/errors.ts";
import { isRecord, readString } from "../src/guard-utils.ts";

describe("toolError", () => {
  it("omits the hint key entirely when there is none", () => {
    const error = toolError(ErrorCode.JJ_MISSING, "jj is not on PATH");
    expect(error).toEqual({
      error: { code: "JJ_MISSING", message: "jj is not on PATH" },
    });
    expect("hint" in error.error).toBe(false);
    // The property that matters: what the model receives has no hint field at
    // all, rather than one it has to interpret.
    expect(JSON.parse(JSON.stringify(error)).error).not.toHaveProperty("hint");
  });

  it("carries the hint when there is one", () => {
    const error = toolError(
      ErrorCode.JJ_MISSING,
      "jj is not on PATH",
      "Install it: brew install jj",
    );
    expect(error.error.hint).toBe("Install it: brew install jj");
  });

  it("uses the code's own string as the value", () => {
    // `ErrorCode` is a const object, not a TS enum, so the wire value is the
    // literal the docs name. A rename that missed the value would be invisible
    // in the types and visible only here.
    expect(toolError(ErrorCode.HUNK_QUERY_EMPTY, "x").error.code).toBe("HUNK_QUERY_EMPTY");
  });
});

describe("guard-utils", () => {
  it("accepts plain objects and rejects everything else", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    // An array is an object, and treating one as a record is how a config read
    // silently picks up index keys.
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it("reads a non-empty string, and nothing else", () => {
    expect(readString({ a: "x" }, "a")).toBe("x");
    // An empty string is treated as absent: the callers are parsing shell output
    // and config, where `""` means "not set" rather than "set to nothing".
    expect(readString({ a: "" }, "a")).toBeUndefined();
    expect(readString({ a: 1 }, "a")).toBeUndefined();
    expect(readString({}, "a")).toBeUndefined();
    expect(readString(null, "a")).toBeUndefined();
    expect(readString("not a record", "a")).toBeUndefined();
  });
});
