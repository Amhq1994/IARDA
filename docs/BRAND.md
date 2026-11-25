# IARDA visual identity — usage rules

These rules apply to every IARDA system screen, email and exported document. Values live in
`brand/tokens.json`; never hard-code a colour that is not listed here.

## Logo

| File | Use on |
|---|---|
| `brand/assets/logo/iarda-logo.png` (1771 × 920, official 2025) | White and light backgrounds: app header, login, emails, report headers |
| `brand/assets/logo/iarda-logo.svg` | Same logo as published on iarda.gov.sa (SVG wrapper) |
| `brand/assets/logo/iarda-logo-white.png` | Green / gradient backgrounds: report covers and closing pages |
| `brand/assets/logo/iarda-logo-on-dark.png` | Colour logo variant for dark green, from the official template |
| `brand/assets/logo/iarda-symbol.png` | Symbol only (official). Used for favicons |

- **Placement:** top header on the start side (right in RTL), login screen, favicon, email header, and every exported page.
- **Do not distort it:** never stretch, recolour, crop, rotate, add effects or place it on a busy photo. Size it by height only.
- **Clear space:** keep at least ¼ of the logo height free on every side.
- **Minimum height:** 40 px on screen and 12 mm in print.

## Colour

| Token | Hex | Use |
|---|---|---|
| `primary` | `#005337` | Header surfaces, primary buttons, table headers, sidebar, success |
| `primaryDark` | `#014F37` | Hover / active, gradients |
| `gold` | `#AE7029` | Page & section titles, highlights, KPI accents, warning |
| `slate` | `#5B7172` | Body text, info |
| `bgLight` | `#EBEEED` | Page background, zebra rows |
| `cream` / `creamDeep` | `#FFF7E7` / `#FFF1D5` | Cards, highlighted rows, info panels, totals |
| `sand` | `#E5DBC8` | Dividers, decorative lines |
| `gray` | `#ADB8B9` | Borders, disabled states |
| `error` | `#A4483E` | Errors only (muted red, harmonised with the palette) |

**Charts** use exactly this order: `#005337`, `#AE7029`, `#5B7172`, `#E5DBC8`, `#014F37`.

**Brand gradient** (login, landing, covers): `linear-gradient(135deg, #014F37 0%, #00A86B 48%, #005337 100%)`.
Add the thin logo motif at low opacity (`.brand-surface`).

## Typography

| Role | Font | Fallback |
|---|---|---|
| UI, tables, headings | SF Mada: Regular 400, Medium 500, Black 900 | IBM Plex Sans Arabic → Tajawal |
| Large titles, covers | Cocon Next Arabic: Light 300, Regular 400 | IBM Plex Sans Arabic Light |

- **Page and section titles:** gold `#AE7029`, bold, preceded by a line icon, with a 2 px green underline.
- **Body text:** slate `#5B7172` at 15 px with line height 1.65.
- **Numbers:** Western digits in both languages, `tabular-nums` in tables and KPIs.

## UI style

- Light, institutional and minimal, on `#EBEEED` and white surfaces.
- 8 px radius everywhere, with the soft green-tinted shadows `--iarda-shadow-sm` and `--iarda-shadow-md`.
- **Icons:** line icons only, from `brand/assets/icons/iarda-icons.svg`, inheriting `currentColor`.
- **Tables:** dark green header with white bold text, thin slate borders and light zebra rows. Highlighted rows are cream and the totals row is cream-deep and bold.
- **Footer:** authority name, copyright and the Vision 2030 logo.
- **Language:** Arabic RTL is the default and English is LTR. Use logical CSS properties only (`inline-start`, `margin-inline-end`, …).

## Exported reports (PDF / PPTX / Excel)

| Page | Treatment |
|---|---|
| Cover | Full-bleed green gradient, 20% sand logo motif, white logo top-left, white title, year in white Black weight at bottom-left |
| Inner | `#EBEEED` background, faint motif in the top corner, gold right-aligned title with icon and green underline, slate body text |
| Tables | `#005337` header with white bold text, centred values, thin `#ADB8B9` borders, zebra rows, totals row in `#FFF1D5` |
| Closing | Same gradient as the cover, "شكراً" / "Thank you" in cream `#FFF1D5`, year |
| Every page | Header: logo and report name. Footer: page number, print date (Hijri + Gregorian), classification, generated-by |

Classification levels: عام Public · داخلي Internal · مقيّد Restricted · سري Confidential · سري للغاية Top Secret.
