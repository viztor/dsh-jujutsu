/**
 * The documentation's own claims, checked against the repository.
 *
 * Twice now a document has stated something the code no longer did: a table of
 * test counts that had gone stale, and a claim that `json(self)` emits
 * newline-delimited JSON when it emits no separator at all. Both were read by
 * someone who had no reason to doubt them.
 *
 * A number in prose cannot be kept true by discipline, only by a check. This
 * file is that check for the counts, which are the claims that drift fastest.
 * It deliberately does **not** try to verify prose — a test that greps for
 * sentences would fail on every rewording and be deleted within a month.
 */

import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Every test file, and the `it(` blocks inside them. */
function testFiles(): string[] {
  return globSync("test/*.test.ts").sort();
}

function declaredTests(): number {
  return testFiles()
    .map((f) => readFileSync(f, "utf8"))
    .reduce((total, text) => total + [...text.matchAll(/^\s+it\(/gm)].length, 0);
}

/** Every `N tests` claim in a document, with the file it came from. */
function claims(): { file: string; count: number; text: string }[] {
  const out: { file: string; count: number; text: string }[] = [];
  for (const file of ["README.md", "src/README.md"]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(\d+) tests\b/g)) {
      out.push({ file, count: Number(m[1]), text: m[0] });
    }
  }
  return out;
}

describe("the documented test count is the real one", () => {
  it("states a count at all", () => {
    // If the claims vanish, the rest of this file silently stops checking
    // anything — which is the failure mode it exists to prevent.
    expect(claims().length).toBeGreaterThan(0);
  });

  it("matches the number of tests that exist", () => {
    const real = declaredTests();
    const wrong = claims().filter((c) => c.count !== real);
    expect(wrong.map((c) => `${c.file}: says "${c.text}", actual is ${real}`)).toEqual([]);
  });

  it("counts every test file, so a new one cannot be forgotten", () => {
    // A suite added without a matching claim leaves the documents understating
    // the work, which is the same class of error as overstating it.
    expect(testFiles().length).toBeGreaterThanOrEqual(8);
    for (const file of testFiles()) {
      expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    }
  });
});

describe("the module map names every module", () => {
  it("lists all of src/ in src/README.md", () => {
    // `state.ts` was missing from the map while three modules imported it. A
    // reader trusting the map would conclude the cached prompt state came from
    // nowhere.
    const map = readFileSync("src/README.md", "utf8");
    const missing = globSync("src/*.ts")
      .map((f) => f.replace("src/", ""))
      .filter((name) => !map.includes(name));
    expect(missing).toEqual([]);
  });
});

describe("the documented artifacts exist", () => {
  it("names files the build actually produces", () => {
    // Three documents claimed `client/panel.js` for two commits after it stopped
    // existing, and `src/README.md` argued at length that there was no bundler
    // while `vp pack` was building the client half. Prose about paths is the
    // fastest thing in a repository to go stale, and nothing was checking it.
    const shipped = [
      "lib/index.js", // the host bundle `main` points at
      "lib/index.d.ts", // its declarations
      "lib/client.js", // the browser half `exports["./client"]` points at
      "locale/en.json", // read by readPluginMeta before any bundle loads
      "locale/zh.json",
      "icon.svg",
      "cordis.patch.yml", // the bundle patch `dsh.bundle` declares
    ];
    const missing = shipped.filter((rel) => !existsSync(rel));
    expect(missing).toEqual([]);
  });

  it("points the manifest at those files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      main: string;
      types: string;
      exports: Record<string, { default?: string } | string>;
      dsh: { bundle: { patch: string } };
    };
    expect(pkg.main).toBe("lib/index.js");
    expect(pkg.types).toBe("lib/index.d.ts");
    expect(pkg.dsh.bundle.patch).toBe("./cordis.patch.yml");
    const client = pkg.exports["./client"];
    expect(typeof client === "string" ? client : client?.default).toBe("./lib/client.js");
  });
});

describe("no document denies a surface the manifest declares", () => {
  it("does not claim the plugin has no UI", () => {
    // `docs/16` said "it has no UI, so no `dsh.client`, no `lib/client.js`, no
    // React, no locale files" — four claims, all four false once the panel
    // landed. `SPEC.md` had the same shape: "Real controls require a
    // hand-written browser-half package, which this plugin does not have."
    //
    // The class is worth a check rather than a fix, because a doc that denies a
    // surface is read as authoritative by exactly the person deciding whether
    // they need it. The manifest is the fact; the prose is the claim.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dsh?: { client?: unknown };
    };
    expect(pkg.dsh?.client, "the manifest declares a client half").toBeDefined();

    const denies = [
      /has no UI/i,
      /no `dsh\.client`/i,
      /no `lib\/client\.js`/i,
      /which this plugin does not have/i,
      /no React/i,
      /no locale files/i,
    ];
    const offenders: string[] = [];
    for (const file of readdirSync("docs").filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join("docs", file), "utf8");
      for (const pattern of denies) {
        if (pattern.test(text)) offenders.push(`docs/${file} matches ${String(pattern)}`);
      }
    }
    for (const file of ["SPEC.md", "README.md"]) {
      const text = readFileSync(file, "utf8");
      for (const pattern of denies) {
        if (pattern.test(text)) offenders.push(`${file} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
