# Fonts

## Official (licensed). Not committed. Provided by IARDA.

Place these files in `brand/fonts/official/`; `brand/css/fonts.css` and the PDF exporter pick them up automatically:

| File | Family / weight |
|---|---|
| `SFMada-Regular.woff2` | SF Mada 400 |
| `SFMada-Medium.woff2` | SF Mada 500–700 |
| `SFMada-Black.woff2` | SF Mada 800–900 |
| `CoconNextArabic-Light.woff2` | Cocon Next Arabic 300 |
| `CoconNextArabic-Regular.woff2` | Cocon Next Arabic 400+ |

If the fonts are installed on the machine (as "SF Mada-V2", "Cocon® Next Arabic"), browsers use the local copies first.

PowerPoint exports reference the installed names (`SF Mada-V2`, `SF Mada-V2 Medium`, `SF Mada-V2 Black`,
`Cocon® Next Arabic`). They can also carry the fonts embedded in the official template: see `IARDA_PPTX_FONT_SOURCE` in the main README.

## Fallback (bundled)

`fallback/`: IBM Plex Sans Arabic (Light, Regular, Medium, SemiBold, Bold), SIL Open Font License 1.1.
After that the stack falls back to Tajawal, then system UI fonts.
