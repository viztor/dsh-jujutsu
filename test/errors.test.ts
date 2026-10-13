/**
 * The error shape the model sees, and the two guards the path parser leans on.
 *
 * `toolError` is small, but its `hint` behaviour is a contract: the value the
 * model reads is JSON, and `{ hint: undefined }` serialises to `{}` while being a
 * present key in the object. The spread is deliberate, and this pins it — every
 * failure the plugin reports should name the next command, so a missing hint
 * should be a missing key rather than a null one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("every error code comes from the vocabulary", () => {
  it("declares no code that is never emitted", () => {
    // This started as a ratchet: fifteen of twenty-four codes were declared and
    // nothing emitted them, so the set was recorded rather than asserted empty,
    // and implementing one meant deleting a line. The last line is gone, so the
    // strict form is now the true one.
    //
    // A declared-but-unused code is a promise the plugin does not keep. It reads
    // as coverage in `docs/26` and answers nothing at runtime.
    const codes = [...readFileSync("src/errors.ts", "utf8").matchAll(/^ {2}([A-Z_]+):/gm)].map(
      (m) => m[1]!,
    );
    const sources = readdirSync("src")
      .filter((f) => f.endsWith(".ts") && f !== "errors.ts")
      .map((f) => readFileSync(join("src", f), "utf8"))
      .join("\n");
    const unused = codes.filter((code) => !sources.includes(`ErrorCode.${code}`));
    expect(unused).toEqual([]);
  });

  it("emits no code that is not declared", () => {
    // The failure this exists for: `JJ_OUTPUT_NOT_JSON` was emitted in `tools.ts`
    // and asserted in a test, and was in no vocabulary at all. A bare string
    // cannot be checked against anything, so it drifted out of `docs/26` and out
    // of `ErrorCode` and nothing noticed.
    const declared = new Set(
      [...readFileSync("src/errors.ts", "utf8").matchAll(/^ {2}([A-Z_]+):/gm)].map((m) => m[1]!),
    );
    const offenders: string[] = [];
    for (const file of readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "errors.ts")) {
      const source = readFileSync(join("src", file), "utf8");
      for (const match of source.matchAll(/code: "([A-Z_]+)"/g)) {
        offenders.push(`${file} emits the bare string ${match[1]}`);
      }
      for (const match of source.matchAll(/code: ErrorCode\.([A-Z_]+)/g)) {
        if (!declared.has(match[1]!)) offenders.push(`${file} emits undeclared ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
