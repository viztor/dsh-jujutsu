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
 *
 * ## The build is atomic, and the path stays where the document puts it
 *
 * The root is a documented path — `docs/20-test-plan.md` §b names it, and so does
 * `helpers.ts` — and the script rebuilds it destructively. Two suite runs at once
 * therefore clobbered each other: one run's rebuild deleted the fixtures the other
 * was reading. That is the same race the e2e root had, and it bit a wave of
 * concurrent runs.
 *
 * So the build goes to a private staging root and is **published by rename**,
 * which is atomic: a reader sees the documented path either absent or complete,
 * never half-built. A run that finds a complete root does not touch it. Two cold
 * starts both build; one wins the rename, the loser discards its staging root and
 * reads the winner's. No lock is involved, so a killed run cannot leave a stale
 * lock behind and wedge every later run.
 *
 * Relocation is safe, and measured rather than assumed: the Git worktree links
 * under `jj-secondary` are relative (`gitdir: ../primary/.git/worktrees/...`), and
 * after moving the whole root, `jj log` in the secondary, `git status` there,
 * `jj root` in `jj-nested/outer/sub` and `git log` in `plain-git` all still
 * resolve. The only absolute path left behind is the `jj workspace add <path>`
 * argument recorded in the operation log — history, not a link.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES, fixturesAvailable } from "./helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The binaries the build needs, or the ones that are missing. */
function missingTools(): string[] {
  return ["jj", "git"].filter((tool) => {
    try {
      execFileSync("/usr/bin/env", [tool, "--version"], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Move a verified build to the documented path.
 *
 * `rename` is the compare-and-swap: it succeeds only when the destination is
 * absent, so a publisher can never overwrite a root another run is reading. A
 * failure means someone else published first — and if their root is complete,
 * that is the desired outcome, so this build is discarded.
 */
function publish(staging: string): void {
  try {
    renameSync(staging, FIXTURES);
    // The build's own footer names the staging root it wrote; say where it went.
    console.log(`\n  fixtures published to ${FIXTURES}\n`);
    return;
  } catch {
    // Someone published between the build and here. Check, rather than assume.
  }

  if (fixturesAvailable()) {
    rmSync(staging, { recursive: true, force: true });
    return;
  }

  throw new Error(
    `${FIXTURES} exists but is not a complete fixture root, so the freshly ` +
      `built one cannot be published. That is a leftover from an interrupted ` +
      `build; remove it and re-run. This code will not delete it, because ` +
      `another run may be reading it.`,
  );
}

export default function setup(): void {
  if (fixturesAvailable()) return;

  const missing = missingTools();

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

  // A sibling of the documented path, so the publish is a same-filesystem
  // rename — a move across filesystems would copy, and a copy is not atomic.
  const staging = mkdtempSync(`${FIXTURES}-build-`);
  try {
    execFileSync(join(ROOT, "test/fixtures/build-fixtures.sh"), [staging], {
      stdio: "inherit",
      cwd: ROOT,
    });
    publish(staging);
  } catch (error) {
    // The script verifies its own output and exits non-zero on a bad build, so a
    // throw here means there is nothing worth publishing.
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
