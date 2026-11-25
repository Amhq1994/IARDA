# WMS in-browser demo (Claude artifact)

Runs the **real** WMS in the browser: the web app, the API route modules and services from `apps/api`, and
PostgreSQL 18 compiled to WebAssembly (PGlite), seeded with the same demo data as the server.

```bash
cd apps/demo
node --import tsx --import ./scripts/alias-register.mjs scripts/build-snapshot.ts   # migrations + seeds → dist-snapshot/
./node_modules/.bin/vite build && node scripts/make-page.mjs                       # dist/ + dist/page.html
```

- Node-only modules are swapped for browser shims (`src/shims`): `pg` → PGlite, `node:crypto` → @noble (same
  AES-256-GCM format), file storage → memory + IndexedDB, Argon2 → salted SHA-256 (demo only).
- `src/runtime/app.ts` is a minimal Fastify-compatible router; `boot.ts` routes `fetch('/api/…')`, links and images to it.
- Data persists per browser in IndexedDB; the demo bar resets it.
- Not available in the demo (server only): report file export (PDF / Excel / PowerPoint), printing and file downloads
  (the artifact frame blocks them), e-mail delivery, integrations to external systems.
- Security controls run in the visitor's browser here, so the demo is for evaluation only — never for real data.
