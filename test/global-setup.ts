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
    // On a machine without the tools, skipping is right: the suite still runs and
    // says what it could not check. In CI it is not right, because a skip is not
    // a failure — `release.yml` ran `pnpm run ci` without installing either
    // binary, so every real-tool test skipped and `verify` passed. A release
    // would have shipped having tested nothing.
    //
    // So the two environments differ, and say so explicitly rather than by
    // accident.
    const message =
      `fixtures: ${missing.join(" and ")} not on PATH. ` +
      `The tests that need a real repository will skip; the rest still run.`;
    if (process.env.DSH_JUJUTSU_REQUIRE_TOOLS === "1") {
      throw new Error(
        `${message}\n\nDSH_JUJUTSU_REQUIRE_TOOLS=1 is set, so this is a failure ` +
          `rather than a skip: the workflow that set it is supposed to install ` +
          `both binaries, and a green run must mean they were exercised.`,
      );
    }
    console.warn(`\n  ${message}\n`);
    return;
  }

  execFileSync(join(ROOT, "test/fixtures/build-fixtures.sh"), [], {
    stdio: "inherit",
    cwd: ROOT,
  });
}
