/**
 * Node loader hooks: stub out CSS imports.
 *
 * The harness's primitives import `./Foo.module.css` and read the resulting
 * class map. A bundler turns those into objects; Node refuses the extension
 * outright (`ERR_UNKNOWN_FILE_EXTENSION`), so rendering them outside a bundler
 * needs this shim.
 *
 * The styles are irrelevant to what is being checked — whether the panel's tree
 * and the components' prop contracts line up. Class names are echoed back rather
 * than dropped, so a component looking up a key still behaves as it would in the
 * browser.
 *
 * Registered by `css-stub-loader.mjs`; kept separate because the registration
 * call and the hook exports must not live in the same module.
 */

export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return {
      url:
        "data:text/javascript," +
        "export default new Proxy({}, { get: (_, k) => String(k) })",
      format: "module",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
