// Node module-resolution hooks: when code under apps/api imports these modules, serve the demo shims instead,
// so the real migrations + seeds run against PGlite exactly as they will in the browser.
const SHIMS = {
  pg: "../src/shims/pg.ts",
  "node:fs/promises": "../src/shims/fs.ts",
  "@node-rs/argon2": "../src/shims/argon2.ts",
};

export async function resolve(specifier, context, next) {
  const target = SHIMS[specifier];
  if (target && context.parentURL && context.parentURL.includes("/apps/api/")) {
    return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
