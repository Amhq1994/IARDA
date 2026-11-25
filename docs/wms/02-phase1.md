# WMS Phase 1 — Data model, auth + RBAC, Item Master, Warehouse Structure

Status: **delivered, awaiting confirmation** before Phase 2 (Inbound, Put-away, Outbound, Material Request workflow).

## What is included

| Area | Delivered |
|---|---|
| **Database** | <ul><li>PostgreSQL 16 schema with 3 migrations.</li><li>Hash-chained, append-only `audit_log` filled by triggers on every business table, including actor, request id, IP, and old/new values.</li><li>`audit_verify()` tamper check.</li><li>Soft-delete guards: physical `DELETE` is refused by trigger and revoked from the runtime role.</li><li>Optimistic locking (`version`).</li><li>Arabic-aware normalisation and duplicate scoring.</li></ul> |
| **Least privilege** | <ul><li>Two DB roles: `wms_owner` runs migrations, `wms_app` runs the API.</li><li>`wms_app` has no `DELETE` or `TRUNCATE`.</li><li>`wms_app` cannot write to `audit_log` at all.</li></ul> |
| **Authentication** | <ul><li>Local accounts with argon2id passwords and a password policy.</li><li>Lockout after 5 failures and a login rate limit.</li><li>DB-backed sessions with 30-minute idle and 12-hour absolute timeouts, in httpOnly SameSite=Strict cookies, plus a CSRF header.</li><li>TOTP MFA enrolment (QR code).</li><li>An immutable `security_event` log.</li><li>SSO (OIDC / Azure AD) entry point; returns *not configured* until the tenant is provided.</li></ul> |
| **RBAC** | <ul><li>All 14 roles seeded with the approved permission matrix (`packages/shared/src/permissions.ts`).</li><li>Warehouse-scoped assignments.</li><li>Matrix editable by the System Admin, with every change audited.</li><li>SoD enforced:<ul><li>a requester, creator or submitter cannot approve an item (SoD-6);</li><li>no-transaction roles can never receive stock permissions.</li></ul></li></ul> |
| **Item Master** | <ul><li>Category > Group > Item hierarchy, with codes in the form `GROUP-00001`.</li><li>Bilingual names and specifications.</li><li>Item types: stock, non-stock, consumable, asset.</li><li>Batch, serial and expiry tracking, with shelf life, weight/volume, hazard class, VED, and ABC/XYZ placeholders.</li><li>UoM conversions.</li><li>Barcode/QR/RFID/MPN identifiers, unique across all items.</li><li>Substitute items.</li><li>Per-warehouse min/max/ROP/safety stock/lead time/picking rule.</li><li>Images, stored encrypted at rest with a SHA-256 integrity check.</li><li>Live duplicate detection that blocks near-identical names until acknowledged.</li><li>Lifecycle: requested → draft → pending approval → active → blocked / obsolete.</li></ul> |
| **Warehouse structure** | <ul><li>Warehouse > Zone (7 types) > Aisle > Rack > Bin; the hierarchy is enforced by the database.</li><li>Capacity by weight and volume, velocity class, hazmat and temperature flags.</li><li>Blocking with a reason.</li><li>Bulk generator for aisles, racks and bins.</li><li>Scan lookup by bin barcode.</li><li>Lazy-loaded tree browser and capacity meters.</li></ul> |
| **Admin & audit UI** | <ul><li>Users: create, temporary password, roles and scopes, unlock, reset, deactivate.</li><li>Permission matrix editor.</li><li>Settings.</li><li>Audit explorer with field-level diffs and chain verification.</li><li>Security events.</li><li>Profile: password change, MFA, language.</li></ul> |
| **Web app** | <ul><li>React PWA-ready SPA on the IARDA theme.</li><li>Arabic RTL by default with English toggle.</li><li>Hijri + Gregorian dates.</li><li>Role-based navigation and dashboards.</li><li>Responsive down to phone width.</li></ul> |
| **API** | <ul><li>REST under `/api`, OpenAPI docs at `/api/docs`.</li><li>Pagination and search on every list.</li><li>Bilingual error format: `{ code, message_ar, message_en, details }`.</li></ul> |
| **Demo data** | <ul><li>9 departments and 26 users covering all 14 roles.</li><li>8 suppliers (fictional).</li><li>3 warehouses with 588 bins.</li><li>12 categories, 36 groups and 200 items with Arabic names.</li><li>Stock policies, substitutes and settings.</li></ul> |

Stock balances, the posting engine, request workflows and the stock KPIs start in Phase 2. Until then their menu entries show "coming soon".

## Run it locally

```bash
# once, as a PostgreSQL superuser
psql -U postgres -f scripts/db-setup.sql

npm install
PSQL_SU="psql -U postgres" scripts/db-reset.sh iarda_wms      # migrate + seed demo data

# development (two terminals)
npm run dev:api                                               # http://localhost:3000  (API, /api/docs)
API_URL=http://localhost:3000 VITE_DEMO=1 npm run dev:web     # http://localhost:5173

# or single origin (API serves the built SPA)
(cd apps/web && VITE_DEMO=1 npx vite build) && npm start      # http://localhost:3000
```

Production environment variables (see `apps/api/src/config.ts`):
- `DATABASE_URL` (runtime role) and `DATABASE_OWNER_URL` (migrations role)
- `DATA_ENCRYPTION_KEY`: 32 random bytes, base64-encoded
- `STORAGE_DIR`
- `COOKIE_SECURE=true`
- `OIDC_ISSUER` and `OIDC_CLIENT_ID`

Never set `VITE_DEMO` for a production build; it shows the demo accounts on the login page.

## Demo accounts (password `Iarda@2026!`)

| Role | Username | Role | Username |
|---|---|---|---|
| System Admin | `admin` | Requester | `req.env`, `req.mnt`, `req.it` |
| Warehouse Manager (Riyadh) | `wm.riyadh` | Department Manager | `dm.env`, `dm.mnt`, `dm.it` |
| Warehouse Manager (North + Spare) | `wm.north` | Inspection Committee | `irc1`, `irc2`, `irc3` |
| Storekeeper | `sk.riyadh`, `sk.north`, `sk.spare` | Count & Disposal Committee | `cdc1`, `cdc2` |
| Warehouse Worker | `ww.riyadh1`, `ww.riyadh2`, `ww.north` | Procurement | `proc` |
| Master Data Officer | `mdo` | Finance | `fin` |
| Inventory Planner | `planner` | Internal Auditor | `auditor` |
| Supplier portal | `supplier.rowad` | | |

## Suggested walkthrough

1. **`mdo` creates an item.** Open *Items → New item* and type `ورق تصوير A4`. The similar-items panel flags OFPAP-00001 as a likely duplicate, and *Create* stays disabled until you acknowledge the duplicates. Finish the item, then click *Submit for approval*.
2. **`mdo` cannot approve it.** This account has no approve button at all.
3. **`wm.riyadh` approves it.** If `wm.riyadh` had requested the item, approval would be refused under SoD-6.
4. **`auditor` reviews the trail.** Open *Audit trail* and click *Verify integrity*. The item's *History* tab shows every step, with old and new values and who acted.
5. **`sk.riyadh` sees only Riyadh.** *Warehouses* lists just the Riyadh warehouse. Opening the northern warehouse directly returns *out of scope*.
6. **`wm.north` generates bins.** Open a zone in the northern warehouse and generate bins. Then browse the tree and block a bin, giving a reason.
7. **`admin` edits the matrix.** Try granting `receipt.execute` to the Auditor role. The change is refused under segregation of duties.

## Tests

```bash
npm run test:api     # 21 API tests: auth, lockout, CSRF, RBAC matrix, SoD-6, duplicates, identifiers,
                     # optimistic locking, policies, audit diff & chain, password masking, DB-level
                     # DELETE/tamper denial, soft delete, warehouse scope, bin generator, hierarchy
npm test             # report exporter tests (PDF/PPTX/XLSX)
```

## Screenshots

`docs/wms/screenshots/`:
- login
- warehouse-manager dashboard
- items list
- new item with duplicate check
- warehouse structure
- permission matrix
- audit trail
- item history
- mobile items list

## Changes from the approved design

- **Data access:** plain SQL migrations with the `pg` driver instead of Prisma, which needs to download engine binaries that restricted networks may block. The database-level guarantees are unchanged.
- **Duplicate scoring:** combines trigram similarity on stemmed Arabic text with bidirectional word similarity. Plural and gender forms (e.g. أقلام…زرقاء vs قلم…أزرق) score about 0.46, so they are shown for review but do not block creation.
