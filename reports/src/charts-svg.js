// Brand-palette SVG charts for the PDF exporter (bar / column, doughnut, line).
// PPTX uses native PowerPoint charts instead; see pptx.js.
const { tokens } = require("./common");

const PALETTE = tokens.chart;
const INK = tokens.color.slate;
const GRID = "#DCE1E0";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/** Vertical columns, grouped when there are several series. RTL puts the first category on the right. */
function bar({ categories, series, rtl, fmt, width = 900, height = 360 }) {
  const pad = { t: 28, b: 44, s: 48, e: 16 };
  const cats = rtl ? [...categories].reverse() : categories;
  const ser = series.map((s) => ({ ...s, values: rtl ? [...s.values].reverse() : s.values }));
  const max = niceMax(Math.max(...ser.flatMap((s) => s.values)));
  const plotW = width - pad.s - pad.e, plotH = height - pad.t - pad.b;
  const x0 = rtl ? pad.e : pad.s;
  const band = plotW / cats.length;
  const groupW = band * 0.62;
  const barW = groupW / ser.length;
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${x0}" x2="${x0 + plotW}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    const ax = rtl ? x0 + plotW + 8 : x0 - 8;
    g += `<text x="${ax}" y="${yy + 4}" font-size="12" fill="${INK}" text-anchor="${rtl ? "start" : "end"}">${esc(fmt(v))}</text>`;
  }
  cats.forEach((c, i) => {
    const gx = x0 + band * i + (band - groupW) / 2;
    ser.forEach((s, j) => {
      const v = s.values[i] ?? 0, bx = gx + barW * j, by = y(v);
      const color = s.color || PALETTE[j % PALETTE.length];
      g += `<rect x="${bx + 2}" y="${by}" width="${barW - 4}" height="${pad.t + plotH - by}" rx="3" fill="${color}"/>`;
      g += `<text x="${bx + barW / 2}" y="${by - 7}" font-size="13" font-weight="700" fill="${tokens.color.primary}" text-anchor="middle">${esc(fmt(v))}</text>`;
    });
    g += `<text x="${x0 + band * i + band / 2}" y="${height - 16}" font-size="13" fill="${INK}" text-anchor="middle">${esc(c)}</text>`;
  });
  g += `<line x1="${x0}" x2="${x0 + plotW}" y1="${pad.t + plotH}" y2="${pad.t + plotH}" stroke="${tokens.color.gray}" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

/** Doughnut for part-to-whole (first series only). Legend is rendered in HTML by the caller. */
function doughnut({ series, width = 320, height = 320 }) {
  const vals = series[0].values;
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = width / 2, cy = height / 2, r = Math.min(cx, cy) - 8, ir = r * 0.6;
  let a0 = -Math.PI / 2, g = "";
  vals.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, rr) => `${cx + rr * Math.cos(rad)} ${cy + rr * Math.sin(rad)}`;
    g += `<path d="M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, ir)} A ${ir} ${ir} 0 ${large} 0 ${p(a0, ir)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="2"/>`;
    a0 = a1;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" xmlns="http://www.w3.org/2000/svg">${g}
    <text x="${cx}" y="${cy + 4}" font-size="30" font-weight="800" fill="${tokens.color.primary}" text-anchor="middle">${total.toLocaleString("en-US")}</text></svg>`;
}

/** Line chart (one or more series). */
function line({ categories, series, rtl, fmt, width = 900, height = 340 }) {
  const pad = { t: 24, b: 44, s: 48, e: 24 };
  const cats = rtl ? [...categories].reverse() : categories;
  const ser = series.map((s) => ({ ...s, values: rtl ? [...s.values].reverse() : s.values }));
  const max = niceMax(Math.max(...ser.flatMap((s) => s.values)));
  const plotW = width - pad.s - pad.e, plotH = height - pad.t - pad.b, x0 = rtl ? pad.e : pad.s;
  const step = cats.length > 1 ? plotW / (cats.length - 1) : 0;
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${x0}" x2="${x0 + plotW}" y1="${yy}" y2="${yy}" stroke="${GRID}"/>`;
    g += `<text x="${rtl ? x0 + plotW + 8 : x0 - 8}" y="${yy + 4}" font-size="12" fill="${INK}" text-anchor="${rtl ? "start" : "end"}">${esc(fmt(v))}</text>`;
  }
  cats.forEach((c, i) => (g += `<text x="${x0 + step * i}" y="${height - 16}" font-size="13" fill="${INK}" text-anchor="middle">${esc(c)}</text>`));
  ser.forEach((s, j) => {
    const color = PALETTE[j % PALETTE.length];
    const pts = s.values.map((v, i) => `${x0 + step * i},${y(v)}`).join(" ");
    g += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.values.forEach((v, i) => (g += `<circle cx="${x0 + step * i}" cy="${y(v)}" r="4" fill="#fff" stroke="${color}" stroke-width="2"/>`));
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

module.exports = { bar, doughnut, line, PALETTE };
