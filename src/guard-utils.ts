/**
 * Narrowing helpers for reading `unknown` honestly.
 *
 * Zero imports, so this module is safe to pull into any context. Predicates
 * rather than assertions: `(value as Record<string, unknown>)` tells the
 * compiler to stop asking at exactly the point where the answer matters — an
 * `exec.arguments` payload, a patch row, an upstream result.
 *
 * @module dsh-jujutsu/guard-utils
 */

/** A non-null, non-array object whose fields can be read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a string field without asserting.
 *
 * @returns the value when it is a non-empty string, otherwise `undefined`.
 */
export function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
