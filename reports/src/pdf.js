// IARDA PDF exporter: cover → content pages (repeating header/footer) → closing page.
// Rendering is done by headless Chromium (Playwright) for correct Arabic shaping and RTL.
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { PDFDocument } = require("pdf-lib");
const { ASSETS, tokens, prepare, totalsRow, dataUri } = require("./common");
const charts = require("./charts-svg");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = tokens.color;

function fontFaces() {
  const off = join(ASSETS.fonts, "official");
  const fb = join(ASSETS.fonts, "fallback");
  const face = (family, file, weight) => existsSync(file)
    ? `@font-face{font-family:"${family}";src:url(${dataUri(file, "font/woff2")}) format("woff2");font-weight:${weight};}` : "";
  return [
    face("SF Mada", join(off, "SFMada-Regular.woff2"), "400"),
    face("SF Mada", join(off, "SFMada-Medium.woff2"), "500 700"),
    face("SF Mada", join(off, "SFMada-Black.woff2"), "800 900"),
    face("Cocon Next Arabic", join(off, "CoconNextArabic-Light.woff2"), "300"),
    face("Cocon Next Arabic", join(off, "CoconNextArabic-Regular.woff2"), "400 900"),
    face("IBM Plex Sans Arabic", join(fb, "IBMPlexSansArabic-Light.woff2"), "300"),
    face("IBM Plex Sans Arabic", join(fb, "IBMPlexSansArabic-Regular.woff2"), "400"),
    face("IBM Plex Sans Arabic", join(fb, "IBMPlexSansArabic-Medium.woff2"), "500"),
    face("IBM Plex Sans Arabic", join(fb, "IBMPlexSansArabic-Bold.woff2"), "600 900"),
  ].join("\n");
}

function iconSvg(name, color) {
  const sprite = readFileSync(ASSETS.iconsSprite, "utf8");
  const m = sprite.match(new RegExp(`<symbol id="i-${name}"[^>]*>([\\s\\S]*?)</symbol>`));
  if (!m) return "";
  return `<svg viewBox="0 0 24 24" class="ico" style="color:${color}" aria-hidden="true">${m[1]}</svg>`;
}

const baseCss = (r) => `
${fontFaces()}
:root { --font: ${tokens.font.primary}; --display: ${tokens.font.display}; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font-family: var(--font); color: ${col.slate}; font-size: 10.5pt; line-height: 1.6; }
.ico { width: 1em; height: 1em; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
`;

/* ------------------------------------------------------------------ cover & closing */
function bleedPage(r, { closing }) {
  const bg = dataUri(ASSETS.coverBg, "image/jpeg");
  const motif = dataUri(ASSETS.motifSandSvg, "image/svg+xml");
  const logo = dataUri(ASSETS.logoWhite, "image/png");
  return `<!doctype html><html lang="${r.lang}" dir="${r.rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
${baseCss(r)}
@page { size: A4; margin: 0; }
.page { position: relative; width: 210mm; height: 296.5mm; overflow: hidden; color: #fff;
  background: ${col.primaryDark} url(${bg}) center / cover no-repeat; }
.motif { position: absolute; top: 8mm; right: -18mm; width: 150mm; opacity: .2; }
.logo { position: absolute; top: 16mm; left: 16mm; height: 34mm; width: auto; }
.title { position: absolute; inset-inline: 18mm; top: 118mm; }
.title h1 { font-family: var(--display); font-weight: 300; font-size: 34pt; line-height: 1.3; margin: 0; color: #fff; }
.title p { margin: 6mm 0 0; font-size: 15pt; color: ${col.creamDeep}; }
.title .meta { margin-top: 10mm; font-size: 10.5pt; color: rgba(255,255,255,.85); }
.year { position: absolute; left: 16mm; bottom: 16mm; font-weight: 900; font-size: 40pt; line-height: 1; color: ${closing ? col.creamDeep : "#fff"}; direction: ltr; }
.thanks { position: absolute; right: 18mm; bottom: 14mm; font-family: var(--display); font-weight: 700; font-size: 66pt; line-height: 1; color: ${col.creamDeep}; }
[dir=ltr] .thanks { right: auto; left: 18mm; bottom: 40mm; }
.org { position: absolute; inset-inline: 18mm; bottom: 46mm; font-size: 11pt; color: rgba(255,255,255,.8); }
</style></head><body><div class="page">
  <img class="motif" src="${motif}" alt="">
  <img class="logo" src="${logo}" alt="${esc(r.orgName)}">
  ${closing
    ? `<div class="thanks">${esc(r.S.thanks)}</div>`
    : `<div class="title"><h1>${esc(r.title)}</h1>${r.subtitle ? `<p>${esc(r.subtitle)}</p>` : ""}
        <div class="meta">${esc(r.orgName)} · ${esc(r.S.classification)}: ${esc(r.classification)}</div></div>`}
  <div class="year">${esc(r.year)}</div>
</div></body></html>`;
}

/* ------------------------------------------------------------------ content */
function renderSection(s, r) {
  const head = `<h2 class="sec-title">${iconSvg(s.icon || "report", col.primary)}<span>${esc(s.title)}</span></h2>`;
  if (s.type === "kpis") {
    return `<section class="sec">${head}<div class="kpis">${s.items.map((k) => `
      <div class="kpi"><div class="kpi-icon">${iconSvg(k.icon || "chart", col.gold)}</div>
      <div class="kpi-val">${esc(r.fmt(k.value, k))}${k.unit ? `<small>${esc(r.t(k.unit))}</small>` : ""}</div>
      <div class="kpi-lbl">${esc(r.t(k.label))}</div></div>`).join("")}</div></section>`;
  }
  if (s.type === "table") {
    const tot = totalsRow(s, r.lang);
    const cell = (c, v, i) => `<td class="${i === 0 && !c.align ? "first" : "num"}">${esc(r.fmt(v, c))}</td>`;
    return `<section class="sec${s.rows.length > 20 ? " long" : ""}">${head}<table class="tbl">
      <colgroup>${s.columns.map((c) => `<col style="width:${((c.width || 1) / s.columns.reduce((a, b) => a + (b.width || 1), 0)) * 100}%">`).join("")}</colgroup>
      <thead><tr>${s.columns.map((c) => `<th>${esc(r.t(c.label))}</th>`).join("")}</tr></thead>
      <tbody>${s.rows.map((row) => `<tr${row._highlight ? ' class="hl"' : ""}>${s.columns.map((c, i) => cell(c, row[c.key], i)).join("")}</tr>`).join("")}</tbody>
      ${tot ? `<tfoot><tr>${s.columns.map((c, i) => cell(c, tot[c.key], i)).join("")}</tr></tfoot>` : ""}
    </table>${s.source ? `<p class="src">${esc(r.S.source)}: ${esc(r.t(s.source))}</p>` : ""}</section>`;
  }
  if (s.type === "chart") {
    const cats = (s.categories || []).map(r.t);
    const series = s.series.map((x) => ({ ...x, name: r.t(x.name) }));
    const fmt = (v) => r.fmt(v);
    let body;
    if (s.chart === "doughnut" || s.chart === "pie") {
      const total = series[0].values.reduce((a, b) => a + b, 0);
      body = `<div class="donut">${charts.doughnut({ series })}<ul class="legend">${cats.map((c, i) => `
        <li><i style="background:${charts.PALETTE[i % charts.PALETTE.length]}"></i><span>${esc(c)}</span>
        <b>${esc(fmt(series[0].values[i]))}</b><em>${esc(r.fmt(series[0].values[i] / total, { format: "percent" }))}</em></li>`).join("")}</ul></div>`;
    } else {
      const svg = (s.chart === "line" ? charts.line : charts.bar)({ categories: cats, series, rtl: r.rtl, fmt });
      const legend = series.length > 1 ? `<ul class="legend row">${series.map((x, i) => `<li><i style="background:${charts.PALETTE[i % charts.PALETTE.length]}"></i>${esc(x.name)}</li>`).join("")}</ul>` : "";
      body = `<div class="chart">${svg}${legend}</div>`;
    }
    return `<section class="sec">${head}${body}${s.note ? `<p class="note">${iconSvg("info", col.gold)}<span>${esc(r.t(s.note))}</span></p>` : ""}</section>`;
  }
  if (s.type === "text") {
    return `<section class="sec">${head}<div class="text">${(s.paragraphs || []).map((p) => `<p>${esc(r.t(p))}</p>`).join("")}</div></section>`;
  }
  return "";
}

function bodyHtml(r) {
  const motif = dataUri(ASSETS.motifLineGreenSvg, "image/svg+xml");
  return `<!doctype html><html lang="${r.lang}" dir="${r.rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
${baseCss(r)}
html, body { background: ${col.bgLight}; }
.motif { position: fixed; top: -12mm; right: -34mm; width: 100mm; opacity: .07; z-index: 0; }
main { position: relative; z-index: 1; padding: 0 14mm; }
.sec { margin: 0 0 9mm; break-inside: avoid; }
.sec.long { break-inside: auto; }
.sec-title { display: inline-flex; align-items: center; gap: 3mm; margin: 0 0 5mm; padding-bottom: 2mm;
  font-size: 16pt; font-weight: 700; color: ${col.gold}; border-bottom: 1.4pt solid ${col.primary}; break-after: avoid; }
.sec-title .ico { width: 18pt; height: 18pt; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(32mm, 1fr)); gap: 4mm; }
.kpi { background: #fff; border-radius: 8px; padding: 4mm; box-shadow: 0 1px 3px rgba(1,79,55,.08); }
.kpi-icon { width: 9mm; height: 9mm; border-radius: 6px; background: ${col.creamDeep}; display: grid; place-items: center; font-size: 14pt; }
.kpi-val { margin-top: 3mm; font-size: 20pt; font-weight: 800; color: ${col.primary}; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi-val small { font-size: 9pt; font-weight: 500; color: ${col.slate}; margin-inline-start: 1mm; }
.kpi-lbl { font-size: 9.5pt; color: ${col.slate}; margin-top: 1mm; }
.tbl { width: 100%; border-collapse: collapse; background: #fff; font-size: 10pt; table-layout: fixed; }
.tbl th { background: ${col.primary}; color: #fff; font-weight: 700; padding: 2.6mm 2mm; text-align: center; border: .5pt solid ${col.primary}; }
.tbl td { padding: 2.2mm 2mm; border: .5pt solid ${col.gray}; text-align: center; font-variant-numeric: tabular-nums; }
.tbl td.first { text-align: start; color: ${col.primaryDark}; font-weight: 500; }
.tbl tbody tr:nth-child(odd) td { background: #fff; }
.tbl tbody tr:nth-child(even) td { background: ${col.bgLight}; }
.tbl tbody tr.hl td { background: ${col.cream}; }
.tbl tfoot td { background: ${col.creamDeep}; color: ${col.primary}; font-weight: 800; border-top: 1.2pt solid ${col.primary}; }
.tbl thead { display: table-header-group; } .tbl tr { break-inside: avoid; }
.chart { background: #fff; border-radius: 8px; padding: 5mm; }
.chart svg text, .donut svg text { font-family: var(--font); }
.donut { background: #fff; border-radius: 8px; padding: 6mm; display: flex; align-items: center; gap: 10mm; }
.donut svg { width: 62mm; height: auto; }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 2.5mm; flex: 1; font-size: 10.5pt; }
.legend li { display: grid; grid-template-columns: 4mm 1fr auto 16mm; align-items: center; gap: 2mm; }
.legend i { width: 3.2mm; height: 3.2mm; border-radius: 1mm; display: inline-block; }
.legend b { color: ${col.primary}; } .legend em { font-style: normal; color: ${col.gold}; font-weight: 700; text-align: end; }
.legend.row { display: flex; gap: 6mm; margin-top: 3mm; } .legend.row li { display: inline-flex; }
.note { display: flex; gap: 2.5mm; align-items: flex-start; margin: 3mm 0 0; padding: 3mm 4mm; border-radius: 8px;
  background: ${col.cream}; border: .5pt solid ${col.sand}; font-size: 10pt; }
.note .ico { margin-top: 1mm; }
.text { background: #fff; border-radius: 8px; padding: 5mm 6mm; }
.text p { margin: 0 0 3mm; } .text p:last-child { margin: 0; }
.src { font-size: 8.5pt; margin: 2mm 0 0; }
</style></head><body><img class="motif" src="${motif}" alt=""><main>
${r.sections.map((s) => renderSection(s, r)).join("\n")}
</main></body></html>`;
}

/* Header / footer templates are rendered by Chromium in the page margins. */
function headerTemplate(r) {
  const logo = dataUri(join(ASSETS.fonts, "..", "assets/raster/iarda-logo-600.png"), "image/png");
  return `<style>${fontFaces().split("\n").filter((l) => l.includes("Regular") || l.includes("Bold") || l.includes("SFMada")).join("")}
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style>
  <div dir="${r.rtl ? "rtl" : "ltr"}" style="--hh:31mm;width:100%;height:var(--hh);margin:-5.5mm 0 0;padding:0 14mm;display:flex;align-items:center;gap:4mm;
    background:${col.bgLight};font-family:${tokens.font.primary.replace(/"/g, "'")};">
    <div style="flex:1;display:flex;align-items:center;gap:3mm;border-bottom:.6pt solid ${col.sand};padding-bottom:3mm;align-self:flex-end;margin-bottom:3mm">
      <span style="font-size:10pt;font-weight:700;color:${col.primary}">${esc(r.title)}</span>
      ${r.subtitle ? `<span style="font-size:8.5pt;color:${col.slate}">· ${esc(r.subtitle)}</span>` : ""}
      <span style="flex:1"></span>
      <img src="${logo}" style="height:13mm;width:auto;margin-bottom:-1mm">
    </div>
  </div>`;
}

function footerTemplate(r) {
  const S = r.S;
  return `<div dir="${r.rtl ? "rtl" : "ltr"}" style="--fh:27mm;width:100%;height:var(--fh);margin:0 0 -1px;display:flex;flex-direction:column;justify-content:center;padding:0 14mm;background:${col.bgLight};
    font-family:${tokens.font.primary.replace(/"/g, "'")};font-size:7.5pt;color:${col.slate};-webkit-print-color-adjust:exact;">
    <div style="display:flex;align-items:center;gap:5mm;border-top:.6pt solid ${col.sand};padding-top:2.5mm">
      <span style="font-weight:700;color:${col.primary};white-space:nowrap">${S.page} <span class="pageNumber"></span> ${S.of} <span class="totalPages"></span></span>
      <span>${S.printed}: <bdi>${esc(r.dates.hijriShort)}</bdi> ${r.rtl ? "هـ" : "AH"} &nbsp;|&nbsp; <bdi>${esc(r.dates.gregShort)}</bdi>${r.rtl ? " م" : ""} &nbsp; <bdi>${esc(r.dates.time)}</bdi></span>
      <span style="flex:1"></span>
      <span>${S.generatedBy}: ${esc(r.generatedBy)}</span>
      <span style="background:${col.creamDeep};color:${col.gold};font-weight:700;padding:.6mm 2.5mm;border-radius:3px;white-space:nowrap">${S.classification}: ${esc(r.classification)}</span>
    </div>
  </div>`;
}

async function launch() {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { throw new Error("PDF export needs Playwright: npm i playwright && npx playwright install chromium"); }
  const opts = process.env.IARDA_CHROMIUM_PATH ? { executablePath: process.env.IARDA_CHROMIUM_PATH } : {};
  return chromium.launch(opts);
}

async function htmlToPdf(browser, html, pdfOpts) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: false, ...pdfOpts });
  await page.close();
  return buf;
}

/** Builds the PDF and returns it as a Buffer (also written to `out` if given). */
async function exportPdf(spec, opts = {}) {
  const r = prepare(spec, opts);
  const browser = await launch();
  try {
    const bleed = { margin: { top: 0, right: 0, bottom: 0, left: 0 } };
    const cover = await htmlToPdf(browser, bleedPage(r, { closing: false }), bleed);
    const body = await htmlToPdf(browser, bodyHtml(r), {
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(r),
      footerTemplate: footerTemplate(r),
      margin: { top: "30mm", bottom: "22mm", left: "0", right: "0" },
    });
    const closing = await htmlToPdf(browser, bleedPage(r, { closing: true }), bleed);

    const doc = await PDFDocument.create();
    doc.setTitle(r.title); doc.setAuthor(r.orgName); doc.setSubject(r.subtitle || r.title);
    doc.setCreator("IARDA report exporter"); doc.setLanguage(r.lang === "ar" ? "ar-SA" : "en");
    for (const part of [cover, body, closing]) {
      const src = await PDFDocument.load(part);
      (await doc.copyPages(src, src.getPageIndices())).forEach((p) => doc.addPage(p));
    }
    const bytes = Buffer.from(await doc.save());
    if (opts.out) writeFileSync(opts.out, bytes);
    return bytes;
  } finally {
    await browser.close();
  }
}

module.exports = { exportPdf, bodyHtml, bleedPage };
