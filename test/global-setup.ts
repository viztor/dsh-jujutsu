/**
 * Build the fixture repositories before the suite runs.
 *
 * They were built by `test/fixtures/build-fixtures.sh` and **nothing called it**.
 * Locally the directory existed because it had been run by hand at some point; in
 * CI it did not exist, so detection found no repository, the guard allowed what it
 * should have refused, and nine tests failed on every push for a week while the
 * suite was green on the machine that wrote them.
 *
 * That is the worst shape a test dependency can take: not a missing import, which
 * fails loudly and immediately, but an out-of-band file that is present for the
 * author and absent for everyone else.
 *
 * So the suite builds it now. When `jj` is not on PATH the build is skipped and
 * says so — the tests that need a real repository skip themselves against
 * `HAS_FIXTURES`, and the rest of the suite still runs. A skip that announces
 * itself is worth more than a red build that names the wrong cause.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Whether the fixture repositories are present and usable. */
export function fixturesAvailable(): boolean {
  return existsSync("/tmp/dsh-jujutsu-fixtures/jj-colocated/.jj");
}

export default function setup(): void {
  if (fixturesAvailable()) return;

  const missing = ["jj", "git"].filter((tool) => {
    try {
      execFileSync("/usr/bin/env", [tool, "--version"], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    console.warn(
      `\n  fixtures: skipped — ${missing.join(" and ")} not on PATH.\n` +
        `  The tests that need a real repository will skip; the rest still run.\n`,
    );
    return;
  }

  execFileSync(join(ROOT, "test/fixtures/build-fixtures.sh"), [], {
    stdio: "inherit",
    cwd: ROOT,
  });
}
