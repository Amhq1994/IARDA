// IARDA PowerPoint exporter — mirrors the official IARDA template:
// 19.6" × 11.03" canvas, green gradient cover/closing, light inner pages with
// gold right-aligned titles, line icons, green underline and brand tables/charts.
const PptxGenJS = require("pptxgenjs");
const { existsSync } = require("node:fs");
const { ASSETS, C, CHART, tokens, prepare, totalsRow } = require("./common");
const { embedFontsFromTemplate, stripDirEntries } = require("./pptx-fonts");

const W = 19.6, H = 11.025;
const F = tokens.font.office;
const ROWS_PER_SLIDE = 11;

function build(spec, opts) {
  const r = prepare(spec, opts);
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "IARDA", width: W, height: H });
  pres.layout = "IARDA";
  pres.rtlMode = r.rtl;
  pres.title = r.title;
  pres.subject = r.subtitle || r.title;
  pres.author = r.orgName;
  pres.company = r.orgName;
  pres.theme = { headFontFace: F.primary, bodyFontFace: F.primary };

  const rtl = r.rtl;
  const align = rtl ? "right" : "left";
  // Template positions are authored for RTL; mirror horizontally for English.
  const mx = (x, w) => (rtl ? x : W - x - w);
  const text = (o) => ({ isTextBox: true, rtlMode: rtl, align, margin: 0, fontFace: F.primary, ...o });

  /* ---------------------------------------------------------------- layouts */
  const footerY = 10.28;
  const footerItems = [
    { text: `${r.S.printed}: ${r.dates.hijriShort} ${rtl ? "هـ" : "AH"} | ${r.dates.gregShort}${rtl ? " م" : ""}`, w: 5.2 },
    { text: `${r.S.generatedBy}: ${r.generatedBy}`, w: 5.2 },
  ];

  pres.defineSlideMaster({
    title: "IARDA_COVER",
    background: { path: ASSETS.coverBg },
    objects: [
      { image: { path: ASSETS.motifSand, x: mx(11.73, 8.17), y: 0.49, w: 8.17, h: 2.64, transparency: 80 } },
      { image: { path: ASSETS.logoWhite, x: mx(0.72, 2.3), y: 1.1, w: 2.3, h: 1.15 } },
      { text: { text: String(r.year), options: text({ x: mx(0.84, 3.2), y: 8.93, w: 3.2, h: 1.08, fontSize: 58, bold: true, color: C.white, fontFace: F.primaryBlack, align: rtl ? "left" : "right", rtlMode: false }) } },
      { text: { text: `${r.S.classification}: ${r.classification}`, options: text({ x: mx(12.4, 6.0), y: 9.55, w: 6.0, h: 0.4, fontSize: 14, color: C.creamDeep }) } },
    ],
  });

  pres.defineSlideMaster({
    title: "IARDA_CONTENT",
    background: { color: C.bgLight },
    margin: [1.2, 0.9, 1.0, 0.9],
    slideNumber: { x: mx(0.9, 1.6), y: footerY, w: 1.6, h: 0.35, fontFace: F.primary, fontSize: 12, color: C.primary, bold: true, align: rtl ? "left" : "right" },
    objects: [
      { image: { path: ASSETS.motifLineGreen, x: mx(15.0, 4.6), y: 0.25, w: 4.6, h: 1.48, transparency: 82 } },
      { image: { path: ASSETS.logo, x: mx(0.9, 1.92), y: 0.42, w: 1.92, h: 1.0 } },
      { text: { text: r.title, options: text({ x: mx(3.1, 6.5), y: 0.62, w: 6.5, h: 0.4, fontSize: 13, color: C.slate, align: rtl ? "left" : "right" }) } },
      // footer rule + footer text
      { line: { x: 0.9, y: footerY - 0.14, w: W - 1.8, h: 0, line: { color: C.sand, width: 0.75 } } },
      { text: { text: footerItems[0].text, options: text({ x: mx(12.9, 5.8), y: footerY, w: 5.8, h: 0.35, fontSize: 13, color: C.slate }) } },
      { text: { text: footerItems[1].text, options: text({ x: mx(7.4, 5.2), y: footerY, w: 5.2, h: 0.35, fontSize: 13, color: C.slate }) } },
      { rect: { x: mx(2.75, 2.9), y: footerY - 0.02, w: 2.9, h: 0.4, fill: { color: C.creamDeep }, rectRadius: 0.06 } },
      { text: { text: `${r.S.classification}: ${r.classification}`, options: text({ x: mx(2.75, 2.9), y: footerY - 0.02, w: 2.9, h: 0.4, fontSize: 13, bold: true, color: C.gold, align: "center" }) } },
    ],
    placeholders: [],
  });

  pres.defineSlideMaster({
    title: "IARDA_CLOSING",
    background: { path: ASSETS.coverBg },
    objects: [
      { image: { path: ASSETS.motifSand, x: mx(11.73, 8.17), y: 0.49, w: 8.17, h: 2.64, transparency: 80 } },
      { image: { path: ASSETS.logoWhite, x: mx(0.72, 2.3), y: 1.1, w: 2.3, h: 1.15 } },
      { text: { text: String(r.year), options: text({ x: mx(0.84, 3.2), y: 9.21, w: 3.2, h: 1.08, fontSize: 58, bold: true, color: C.creamDeep, fontFace: F.primaryBlack, align: rtl ? "left" : "right", rtlMode: false }) } },
    ],
  });

  /* ---------------------------------------------------------------- helpers */
  const newContent = (title, icon) => {
    const s = pres.addSlide({ masterName: "IARDA_CONTENT" });
    s.addText(title, text({ x: mx(3.4, 14.0), y: 1.22, w: 14.0, h: 0.72, fontSize: 34, bold: true, color: C.gold, valign: "bottom", objectName: "Title" }));
    const ic = ASSETS.icon(icon || "report", "green");
    if (existsSync(ic)) s.addImage({ path: ic, x: mx(17.58, 0.62), y: 1.26, w: 0.62, h: 0.62, altText: "" });
    // thin green underline accent, sized to the title (≈0.24" per character at 34pt) and extending under the icon
    const lw = Math.min(16.6, Math.max(3.5, String(title).length * (rtl ? 0.235 : 0.215) + 0.95));
    s.addShape(pres.shapes.LINE, { x: mx(18.2 - lw, lw), y: 2.02, w: lw, h: 0, line: { color: C.primary, width: 1.5 } });
    return s;
  };
  const card = (s, x, y, w, h, fill = C.white) =>
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.1, fill: { color: fill }, line: { color: fill, width: 0 },
      shadow: { type: "outer", color: "014F37", opacity: 0.1, blur: 6, offset: 1.5, angle: 90 } });

  const BODY = { x: 0.9, y: 2.45, w: W - 1.8, h: 7.45 };

  /* ---------------------------------------------------------------- cover */
  const cover = pres.addSlide({ masterName: "IARDA_COVER" });
  cover.addText(r.title, text({ x: mx(1.8, 16.0), y: 4.1, w: 16.0, h: 1.6, fontSize: 60, color: C.white, fontFace: F.display, valign: "bottom" }));
  if (r.subtitle) cover.addText(r.subtitle, text({ x: mx(1.8, 16.0), y: 5.85, w: 16.0, h: 0.7, fontSize: 26, color: C.creamDeep }));
  cover.addText(r.orgName, text({ x: mx(1.8, 16.0), y: 6.6, w: 16.0, h: 0.5, fontSize: 16, color: C.white, transparency: 15 }));

  /* ---------------------------------------------------------------- sections */
  for (const sec of r.sections) {
    if (sec.type === "kpis") {
      const s = newContent(sec.title, sec.icon);
      const n = sec.items.length, gap = 0.4;
      const cw = (BODY.w - gap * (n - 1)) / n, ch = 4.4, y = 3.9;
      sec.items.forEach((k, i) => {
        const x = rtl ? BODY.x + BODY.w - cw - i * (cw + gap) : BODY.x + i * (cw + gap);
        card(s, x, y, cw, ch);
        s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rtl ? x + cw - 1.2 : x + 0.4, y: y + 0.4, w: 0.8, h: 0.8, rectRadius: 0.1, fill: { color: C.creamDeep }, line: { color: C.creamDeep, width: 0 } });
        const ic = ASSETS.icon(k.icon || "chart", "gold");
        if (existsSync(ic)) s.addImage({ path: ic, x: (rtl ? x + cw - 1.2 : x + 0.4) + 0.17, y: y + 0.57, w: 0.46, h: 0.46 });
        s.addText(r.fmt(k.value, k) + (k.unit ? ` ${r.t(k.unit)}` : ""), text({ x: x + 0.4, y: y + 1.75, w: cw - 0.8, h: 1.25, fontSize: 60, bold: true, color: C.primary, fontFace: F.primaryBlack }));
        s.addText(r.t(k.label), text({ x: x + 0.4, y: y + 3.15, w: cw - 0.8, h: 0.6, fontSize: 22, color: C.slate }));
      });
    }

    if (sec.type === "table") {
      const cols = rtl ? [...sec.columns].reverse() : sec.columns;
      const firstKey = sec.columns[0].key;
      const totW = sec.columns.reduce((a, c) => a + (c.width || 1), 0);
      const colW = cols.map((c) => ((c.width || 1) / totW) * BODY.w);
      const border = { type: "solid", pt: 0.75, color: C.gray };
      const head = cols.map((c) => ({ text: r.t(c.label), options: { bold: true, color: C.white, fill: { color: C.primary }, align: "center", fontFace: F.primaryMedium, fontSize: 18 } }));
      const mkRow = (row, i, isTotal) => cols.map((c) => {
        const first = c.key === firstKey;
        return { text: r.fmt(row[c.key], c), options: {
          align: first ? align : "center", rtlMode: rtl, fontSize: 16, bold: isTotal || first,
          color: isTotal ? C.primary : first ? C.primaryDark : C.slate,
          fill: { color: isTotal ? C.creamDeep : row._highlight ? C.cream : i % 2 ? C.bgLight : C.white },
        } };
      });
      const tot = totalsRow(sec, r.lang);
      const pages = [];
      for (let i = 0; i < sec.rows.length; i += ROWS_PER_SLIDE) pages.push(sec.rows.slice(i, i + ROWS_PER_SLIDE));
      pages.forEach((rows, p) => {
        const title = p === 0 ? sec.title : `${sec.title} (${r.S.continued})`;
        const s = newContent(title, sec.icon);
        const body = [head, ...rows.map((row, i) => mkRow(row, i, false))];
        if (tot && p === pages.length - 1) body.push(mkRow(tot, 0, true));
        s.addTable(body, { x: BODY.x, y: BODY.y, w: BODY.w, colW, rowH: 0.56, valign: "middle", border, fontFace: F.primary, margin: [0, 0.12, 0, 0.12], objectName: "Data table" });
      });
    }

    if (sec.type === "chart") {
      const s = newContent(sec.title, sec.icon);
      const cats = (sec.categories || []).map(r.t);
      const data = sec.series.map((x) => ({ name: r.t(x.name), labels: cats, values: x.values }));
      const hasNote = !!sec.note;
      const chartW = hasNote ? BODY.w - 5.2 : BODY.w;
      const cx = rtl ? BODY.x + BODY.w - chartW : BODY.x;
      card(s, cx, BODY.y, chartW, BODY.h);
      const base = {
        x: cx + 0.3, y: BODY.y + 0.3, w: chartW - 0.6, h: BODY.h - 0.6,
        chartColors: CHART.slice(0, Math.max(data.length, sec.chart === "doughnut" || sec.chart === "pie" ? cats.length : 1)),
        catAxisLabelColor: C.slate, valAxisLabelColor: C.slate, catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt",
        catAxisLabelFontSize: 16, valAxisLabelFontSize: 14, dataLabelFontFace: "+mn-lt", dataLabelFontSize: 18, dataLabelColor: C.primary,
        legendFontFace: "+mn-lt", legendFontSize: 20, legendColor: C.slate,
        valGridLine: { color: "DCE1E0", size: 0.75 }, catGridLine: { style: "none" },
        showLegend: data.length > 1, legendPos: "b",
      };
      if (sec.chart === "doughnut" || sec.chart === "pie") {
        s.addChart(sec.chart === "pie" ? pres.charts.PIE : pres.charts.DOUGHNUT, data.slice(0, 1), {
          ...base, holeSize: 58, showLegend: true, legendPos: rtl ? "l" : "r", showPercent: true, showValue: false,
          dataLabelColor: C.white, dataLabelFontBold: true, dataBorder: { pt: 1.5, color: C.white },
        });
      } else if (sec.chart === "line") {
        s.addChart(pres.charts.LINE, data, { ...base, lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 8, catAxisOrientation: rtl ? "maxMin" : "minMax" });
      } else {
        s.addChart(pres.charts.BAR, data, {
          ...base, barDir: "col", barGapWidthPct: 70, showValue: true, dataLabelPosition: "outEnd", dataLabelFontBold: true,
          catAxisOrientation: rtl ? "maxMin" : "minMax", valAxisHidden: false,
        });
      }
      if (hasNote) {
        const nx = rtl ? BODY.x : BODY.x + BODY.w - 4.8;
        s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: nx, y: BODY.y, w: 4.8, h: 3.2, rectRadius: 0.1, fill: { color: C.cream }, line: { color: C.sand, width: 0.75 } });
        const ic = ASSETS.icon("info", "gold");
        if (existsSync(ic)) s.addImage({ path: ic, x: rtl ? nx + 4.8 - 0.95 : nx + 0.35, y: BODY.y + 0.35, w: 0.6, h: 0.6 });
        s.addText(r.t(sec.note), text({ x: nx + 0.35, y: BODY.y + 1.15, w: 4.1, h: 1.8, fontSize: 18, color: C.slate, valign: "top" }));
      }
    }

    if (sec.type === "text") {
      const s = newContent(sec.title, sec.icon);
      card(s, BODY.x, BODY.y, BODY.w, BODY.h);
      s.addText(
        (sec.paragraphs || []).map((p, i, a) => ({ text: r.t(p), options: { breakLine: i < a.length - 1, paraSpaceAfter: 14 } })),
        text({ x: BODY.x + 0.6, y: BODY.y + 0.5, w: BODY.w - 1.2, h: BODY.h - 1.0, fontSize: 24, color: C.slate, valign: "top", lineSpacingMultiple: 1.3 })
      );
    }
  }

  /* ---------------------------------------------------------------- closing */
  const end = pres.addSlide({ masterName: "IARDA_CLOSING" });
  end.addText(r.S.thanks, text({ x: mx(11.5, 7.15), y: 8.5, w: 7.15, h: 1.8, fontSize: rtl ? 88 : 72, bold: true, color: C.creamDeep, fontFace: F.primaryBlack, valign: "bottom" }));

  return { pres, r };
}

async function exportPptx(spec, opts = {}) {
  const { pres } = build(spec, opts);
  if (!opts.out) return pres.write({ outputType: "nodebuffer" });
  await pres.writeFile({ fileName: opts.out });
  await stripDirEntries(opts.out);
  const fontSource = opts.fontSource || process.env.IARDA_PPTX_FONT_SOURCE;
  if (fontSource) await embedFontsFromTemplate(opts.out, fontSource);
  return opts.out;
}

module.exports = { exportPptx };
