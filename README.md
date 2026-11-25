# IARDA — Brand Identity System & Warehouse Management System

This repository holds:
- **WMS:** the Warehouse Management & Inventory Control System, in `apps/`, `packages/` and `docs/wms/`.
  - Phase 1 is delivered; see [`docs/wms/02-phase1.md`](docs/wms/02-phase1.md) for setup, demo accounts and a walkthrough.
  - Phase 2 (inbound, put-away, material requests, approvals, picking, delivery) is delivered; see [`docs/wms/03-phase2.md`](docs/wms/03-phase2.md).
  - The approved design is in [`docs/wms/01-design.md`](docs/wms/01-design.md).
- **Brand layer:** the IARDA brand identity system that the WMS is built on (described below).

Visual identity layer for the systems of the **Imam Abdulaziz bin Mohammed Royal Reserve Development Authority**
(هيئة تطوير محمية الإمام عبدالعزيز بن محمد الملكية) — <https://www.iarda.gov.sa/>.

Everything a system needs to look like IARDA: design tokens, a drop-in RTL CSS theme, logo / favicon / icon
assets, reference screens, an email template, and exporters that turn report data into **PDF, PowerPoint and
Excel** files that follow the official IARDA presentation template.

| Path | What it is |
|---|---|
| `brand/tokens.json` | Single source of truth: colours, chart palette, gradient, fonts, radius, shadows |
| `brand/css/iarda.css` | UI theme (header, green sidebar, gold section titles, tables, KPIs, forms, badges, login) |
| `brand/assets/logo/` | Official logos: colour (light backgrounds), white (green backgrounds), symbol |
| `brand/assets/favicon/` | `favicon.ico`, 32/180/192/512 PNGs |
| `brand/assets/icons/iarda-icons.svg` | Line icon sprite (24 px grid, 1.75 stroke, `currentColor`) |
| `brand/assets/motif/` | Logo-derived geometric line motif (white / green / gold / sand) |
| `brand/fonts/` | Font loading; drop licensed SF Mada & Cocon files into `official/` |
| `web/` | Reference screens: `index.html` (brand guide), `login.html`, `dashboard.html` |
| `email/notification.html` | Branded, client-safe HTML email notification |
| `reports/` | PDF / PPTX / XLSX report exporter (Node) — see below |
| `docs/BRAND.md` | Usage rules for developers and designers |
| `docs/samples/` | Generated sample reports (Arabic + English) |

## Quick start

```bash
npm install
npm run preview            # http://localhost:4173/  (brand guide, login, dashboard)
npm run samples            # regenerate docs/samples/*.pdf|pptx|xlsx
npm test
```

### Use the theme in a system

```html
<html lang="ar" dir="rtl">
  <link rel="icon" href="/brand/assets/favicon/favicon.ico">
  <link rel="stylesheet" href="/brand/css/iarda.css">
```

Then use the classes shown in `web/dashboard.html` (`.app`, `.app-header`, `.app-sidebar`, `.page-title`,
`.section-title`, `.card`, `.kpi`, `.table`, `.btn--primary`, `.badge--success`, `.brand-surface`, …).
All spacing uses logical properties, so switching to `dir="ltr"` mirrors the layout for English.

### Export a report

```bash
node reports/cli.js reports/examples/camps-report.json --lang ar --format pdf,pptx,xlsx \
     --user "Abdulaziz A." --classification confidential --out out/
```

```js
const { exportReport } = require("./reports/src");
await exportReport(spec, { lang: "ar", formats: ["pdf", "pptx", "xlsx"], base: "out/camps-2026" });
```

A report spec is JSON: `title`, `subtitle`, `year`, `classification` (`public | internal | restricted |
confidential | secret`), `generatedBy`, and `sections` of type `kpis`, `table`, `chart` (`bar | line |
doughnut | pie`) or `text`. Every text field accepts either a string or `{ "ar": "…", "en": "…" }`.
See `reports/examples/camps-report.json`.

Every export has:
- **Cover:** green gradient, logo motif, white title, year at bottom-left.
- **Inner pages:** `#EBEEED` background, gold right-aligned titles with an icon and green underline.
- **Tables:** `#005337` header, zebra rows, highlighted totals row.
- **Charts:** brand palette in order.
- **Closing page:** "شكراً".
- **Header and footer:** logo and report name in the header; the footer carries page number, Hijri + Gregorian print date, classification and generated-by.

| Format | Engine | Notes |
|---|---|---|
| PDF | Playwright / Chromium | Correct Arabic shaping; A4; repeating header & footer |
| PPTX | pptxgenjs | Same 19.6″ × 11″ canvas and positions as the official template; native, editable charts |
| XLSX | ExcelJS | RTL sheets, frozen header, filters, live `SUM` totals, print header/footer; chart data as tables |

**PDF** needs Playwright with Chromium (`npm i playwright && npx playwright install chromium`, or point
`IARDA_CHROMIUM_PATH` at an existing Chrome).

**PowerPoint fonts:** set `IARDA_PPTX_FONT_SOURCE=/path/to/official-template.pptx`. The exporter then copies
the SF Mada and Cocon Next Arabic fonts embedded in the template into each deck. Recipients without those fonts
installed then see the real brand fonts. The font data is read at export time and is never stored in this repo.

## Still needed from the Authority

1. **Licensed font files:** SF Mada (Regular, Medium, Black) and Cocon Next Arabic (Light, Regular) as `.woff2`
   in `brand/fonts/official/` (names in `brand/fonts/README.md`). Until then the UI uses IBM Plex Sans Arabic
   (bundled, OFL) and then Tajawal.
2. **Vision 2030 logo:** the approved file as `brand/assets/partners/vision2030.svg`. Footers show it as soon as
   it exists.
3. **High-resolution white logo:** the white (reversed) logo used on green covers comes from the PowerPoint
   template and is only 248 px wide. A vector or ≥1200 px PNG version should replace
   `brand/assets/logo/iarda-logo-white.png`.

## Regenerating derived files

```bash
npm run build:tokens     # tokens.json → brand/css/tokens.css + reports/src/tokens.generated.js
npm run build:raster     # icons & motifs → brand/assets/raster/*.png (needs Playwright)
npm run build:favicons   # favicons from the official symbol (needs Python + Pillow)
```
