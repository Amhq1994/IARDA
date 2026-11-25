// Builds the in-browser demo: the real web app + the real API modules + PGlite, with Node built-ins swapped for
// browser shims. Output: dist/ (relative paths, hash routing) ready to publish as a Claude artifact.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The web app references brand assets by absolute "/brand/..." paths; the artifact serves them next to the page. */
const relativeBrand = (): Plugin => ({
  name: "relative-brand",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/apps/web/src/") || !/\.(tsx?|jsx?)$/.test(id)) return null;
    return code.replace(/(["'`])\/brand\//g, "$1./brand/");
  },
});

export default defineConfig({
  root: here("."),
  base: "./",
  publicDir: here("./public"),
  plugins: [relativeBrand(), react()],
  define: {
    "process.env": "{}",
    "import.meta.env.VITE_DEMO": JSON.stringify("1"),
    "import.meta.env.VITE_ARTIFACT": JSON.stringify("1"),
  },
  resolve: {
    alias: [
      { find: /^pg$/, replacement: here("./src/shims/pg.ts") },
      { find: /^node:crypto$/, replacement: here("./src/shims/crypto.ts") },
      { find: /^node:fs(\/promises)?$/, replacement: here("./src/shims/fs.ts") },
      { find: /^node:(path|os|url)$/, replacement: here("./src/shims/misc.ts") },
      { find: /^node:module$/, replacement: here("./src/shims/module.ts") },
      { find: /^@node-rs\/argon2$/, replacement: here("./src/shims/argon2.ts") },
      { find: /^nodemailer$/, replacement: here("./src/shims/empty.ts") },
    ],
  },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  assetsInclude: ["**/*.tar.gz"],
  worker: { format: "es" },
  build: {
    outDir: here("./dist"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: { fs: { allow: [here("../..")] } },
});
