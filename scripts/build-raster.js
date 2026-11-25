// Renders SVG brand assets to transparent PNGs for Office exports (PowerPoint/Excel
// handle PNG far more reliably than SVG). Requires Playwright's Chromium.
//   node scripts/build-raster.js
const { chromium } = require("playwright");
const { readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const out = join(root, "brand/assets/raster");
mkdirSync(out, { recursive: true });

const sprite = readFileSync(join(root, "brand/assets/icons/iarda-icons.svg"), "utf8");
const ICONS = ["dashboard", "report", "table", "chart", "map", "leaf", "camp", "users", "calendar", "shield", "star", "check", "info", "alert"];
const ICON_COLORS = { green: "#005337", gold: "#AE7029", white: "#FFFFFF" };
const MOTIFS = ["motif-sand", "motif-line-white", "motif-line-green", "motif-line-gold"];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  async function render(html, w, h, file) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
    await page.screenshot({ path: join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  }

  for (const name of ICONS) {
    for (const [cname, color] of Object.entries(ICON_COLORS)) {
      await render(
        `${sprite}<svg width="256" height="256" style="display:block;color:${color};fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round"><use href="#i-${name}"/></svg>`,
        256, 256, `icon-${name}-${cname}.png`
      );
    }
  }
  for (const m of MOTIFS) {
    const svg = readFileSync(join(root, `brand/assets/motif/${m}.svg`), "utf8")
      .replace(/<svg /, '<svg width="2400" height="775" ');
    await render(`<div style="width:2400px;height:775px">${svg}</div>`, 2400, 775, `${m}.png`);
  }
  await browser.close();
  console.log("raster assets written to", out);
})();
