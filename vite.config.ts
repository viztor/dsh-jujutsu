import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration.
 *
 * Only the **client** half is built here. The host half stays on `tsc`
 * (`tsconfig.build.json`), which already emits the ESM the harness imports and
 * the declarations beside it; moving it would be churn for no gain.
 *
 * The client half is the part that cannot be plain `tsc` output. The web client
 * does not `import` a client bundle — it evaluates it as a script that registers
 * a factory, and hands that factory a `require`:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * `banner`/`footer` express that wrapper in the bundler instead of a hand-rolled
 * script. The earlier build did exactly this by hand, in JavaScript, next to a
 * TypeScript source it could not typecheck. The shape was right; where it lived
 * was not.
 *
 * The dependency list matters as much as the wrapper: React and the primitives
 * arrive from the host's module loader at runtime, so bundling either would put
 * a second copy in the page beside the client's own.
 */
export default defineConfig({
  pack: [
    {
      // A named entry, so the artifact is `lib/client.*` rather than
      // `lib/panel.*`: `client` is what the harness calls the browser half.
      entry: { client: "src/client/panel.ts" },
      outDir: "lib",
      // CommonJS, because the loader hands the bundle a `require` and expects
      // `module.exports`. That is the wrapper's shape, not a module-system
      // preference.
      format: ["cjs"],
      platform: "browser",
      // Nothing imports this bundle — the loader calls it — so declarations
      // would describe a module no consumer can import.
      dts: false,
      sourcemap: false,
      clean: false,
      deps: {
        neverBundle: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      },
      banner: [
        "(function () {",
        "  var factory = function (require) {",
        "    var module = { exports: {} };",
        "    var exports = module.exports;",
      ].join("\n"),
      footer: [
        "    return module.exports;",
        "  };",
        '  window.__ModuleLoader__.load({ id: "dsh-jujutsu", factory: factory });',
        "})();",
      ].join("\n"),
    },
  ],

  test: {
    // The fixture repositories are built here rather than assumed. They were
    // built by a script nothing invoked, which made the suite pass on the machine
    // that had run it by hand and fail everywhere else.
    globalSetup: ["test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    // No alias for the primitives: the panel imports them **type-only**, which
    // is erased, so nothing resolves the package at runtime outside the browser.
    // An alias here would stub a module no test loads.
  },
});
