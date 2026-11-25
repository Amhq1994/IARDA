// IARDA Excel exporter: one branded sheet per table (plus a summary sheet for KPIs
// and a data sheet per chart). RTL sheets in Arabic, logo + report name header,
// green table headers, zebra rows, highlighted totals, and print header/footer
// with page number, Hijri + Gregorian print date, classification and author.
const ExcelJS = require("exceljs");
const { ASSETS, C, tokens, prepare, totalsRow } = require("./common");

const F = tokens.font.office;
const argb = (hex) => "FF" + hex;
const thin = { style: "thin", color: { argb: argb(C.gray) } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function sheetName(name, used) {
  let base = String(name).replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Sheet";
  let n = base, i = 2;
  while (used.has(n)) n = `${base.slice(0, 26)} ${i++}`;
  used.add(n);
  return n;
}

function setupSheet(wb, r, name, ncols, logoId, heading = name) {
  const ws = wb.addWorksheet(name, {
    views: [{ rightToLeft: r.rtl, showGridLines: false, state: "frozen", ySplit: 6 }],
    properties: { defaultRowHeight: 20 },
    pageSetup: {
      paperSize: 9, orientation: ncols > 5 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, margins: { left: 0.5, right: 0.5, top: 0.9, bottom: 0.75, header: 0.3, footer: 0.3 },
      printTitlesRow: "6:6",
    },
  });
  const S = r.S;
  const esc = (s) => String(s).replace(/&/g, "&&");
  const printed = `${S.printed}: ${r.dates.hijriShort} ${r.rtl ? "هـ" : "AH"} | ${r.dates.gregShort}`;
  ws.headerFooter = {
    oddHeader: `&L&"${F.primary},Bold"&10&K${C.primary}${esc(r.title)}&R&"${F.primary},Regular"&9&K${C.slate}${esc(r.orgName)}`,
    oddFooter: `&L&"${F.primary},Regular"&8&K${C.slate}${esc(printed)} · ${esc(S.generatedBy)}: ${esc(r.generatedBy)}&C&"${F.primary},Bold"&9&K${C.primary}&P / &N&R&"${F.primary},Bold"&8&K${C.gold}${esc(S.classification)}: ${esc(r.classification)}`,
  };

  // Rows 1–5: brand header block
  const last = Math.max(ncols, 4);
  ws.getRow(1).height = 18;
  ws.getRow(2).height = 34;
  ws.getRow(3).height = 22;
  ws.getRow(4).height = 18;
  ws.getRow(5).height = 10;
  // logo occupies the start corner (top-right in RTL); never stretched (aspect 1.925 : 1)
  ws.addImage(logoId, { tl: { col: 0.15, row: 0.2 }, ext: { width: 150, height: 78 }, editAs: "absolute" });
  const titleFrom = 2;
  ws.mergeCells(2, titleFrom, 2, last);
  Object.assign(ws.getCell(2, titleFrom), {
    value: r.title,
    font: { name: F.primary, size: 18, bold: true, color: { argb: argb(C.gold) } },
    alignment: { horizontal: r.rtl ? "right" : "left", vertical: "middle", readingOrder: r.rtl ? "rtl" : "ltr" },
  });
  ws.mergeCells(3, titleFrom, 3, last);
  Object.assign(ws.getCell(3, titleFrom), {
    value: [heading !== r.title ? heading : "", r.subtitle].filter(Boolean).join(" · "),
    font: { name: F.primary, size: 11, color: { argb: argb(C.slate) } },
    alignment: { horizontal: r.rtl ? "right" : "left", vertical: "middle", readingOrder: r.rtl ? "rtl" : "ltr" },
  });
  ws.mergeCells(4, titleFrom, 4, last);
  Object.assign(ws.getCell(4, titleFrom), {
    value: `${printed}   ·   ${S.classification}: ${r.classification}`,
    font: { name: F.primary, size: 9, color: { argb: argb(C.slate) } },
    alignment: { horizontal: r.rtl ? "right" : "left", vertical: "middle", readingOrder: r.rtl ? "rtl" : "ltr" },
  });
  // thin green underline accent below the title block
  for (let c = titleFrom; c <= last; c++) ws.getCell(4, c).border = { bottom: { style: "thin", color: { argb: argb(C.primary) } } };
  return ws;
}

function writeTable(ws, r, columns, rows, totals, startRow = 6) {
  const align = r.rtl ? "right" : "left";
  const hdr = ws.getRow(startRow);
  hdr.height = 28;
  columns.forEach((c, i) => {
    Object.assign(hdr.getCell(i + 1), {
      value: r.t(c.label),
      font: { name: F.primary, size: 11, bold: true, color: { argb: "FFFFFFFF" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: argb(C.primary) } },
      alignment: { horizontal: "center", vertical: "middle", wrapText: true, readingOrder: r.rtl ? "rtl" : "ltr" },
      border: BORDER,
    });
  });
  const numFmt = (c) => (c.format === "percent" ? "0.0%" : c.format === "currency" ? '#,##0.00 "SAR"' : "#,##0.##");
  const put = (rowIdx, row, kind, i) => {
    const xr = ws.getRow(rowIdx);
    xr.height = 22;
    const fill = kind === "total" ? C.creamDeep : row._highlight ? C.cream : i % 2 ? C.bgLight : "FFFFFF";
    columns.forEach((c, j) => {
      const v = row[c.key];
      const cell = xr.getCell(j + 1);
      cell.value = typeof v === "number" ? v : v == null ? null : String(r.t(v));
      if (typeof v === "number") cell.numFmt = numFmt(c);
      cell.font = { name: F.primary, size: 11, bold: kind === "total" || j === 0, color: { argb: argb(kind === "total" ? C.primary : j === 0 ? C.primaryDark : C.slate) } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fill) } };
      cell.alignment = { horizontal: j === 0 ? align : "center", vertical: "middle", readingOrder: r.rtl ? "rtl" : "ltr" };
      cell.border = kind === "total" ? { ...BORDER, top: { style: "medium", color: { argb: argb(C.primary) } } } : BORDER;
    });
  };
  rows.forEach((row, i) => put(startRow + 1 + i, row, "row", i));
  if (totals) {
    // live formulas for numeric totals so edits in Excel stay correct
    const tr = startRow + 1 + rows.length;
    put(tr, totals, "total", 0);
    columns.forEach((c, j) => {
      if (typeof totals[c.key] === "number") {
        const L = ws.getColumn(j + 1).letter;
        ws.getCell(tr, j + 1).value = { formula: `SUM(${L}${startRow + 1}:${L}${tr - 1})`, result: totals[c.key] };
      }
    });
  }
  columns.forEach((c, j) => {
    const longest = Math.max(String(r.t(c.label)).length, ...rows.map((row) => String(r.fmt(row[c.key], c)).length));
    ws.getColumn(j + 1).width = Math.min(48, Math.max(j === 0 ? 24 : 14, longest * 1.25 + 4));
  });
  ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + rows.length, column: columns.length } };
}

async function exportXlsx(spec, opts = {}) {
  const r = prepare(spec, opts);
  const wb = new ExcelJS.Workbook();
  wb.creator = r.orgName;
  wb.company = r.orgName;
  wb.title = r.title;
  wb.subject = r.subtitle || r.title;
  wb.created = new Date();
  const logoId = wb.addImage({ filename: ASSETS.logo, extension: "png" });
  const used = new Set();

  const kpis = r.sections.filter((s) => s.type === "kpis");
  if (kpis.length) {
    const cols = [
      { key: "label", label: { ar: "المؤشر", en: "Indicator" }, width: 2 },
      { key: "value", label: { ar: "القيمة", en: "Value" } },
    ];
    const rows = kpis.flatMap((s) => s.items.map((k) => ({ label: r.t(k.label), value: k.value })));
    const ws = setupSheet(wb, r, sheetName(kpis[0].title, used), cols.length + 2, logoId, kpis[0].title);
    writeTable(ws, r, cols, rows, null);
  }

  for (const s of r.sections) {
    if (s.type === "table") {
      const ws = setupSheet(wb, r, sheetName(s.title, used), s.columns.length, logoId, s.title);
      writeTable(ws, r, s.columns, s.rows, totalsRow(s, r.lang));
    }
    if (s.type === "chart") {
      // Chart data as a branded table (ExcelJS cannot author native Excel charts).
      const cols = [{ key: "cat", label: { ar: "الفئة", en: "Category" } }, ...s.series.map((x, i) => ({ key: `s${i}`, label: x.name }))];
      const rows = (s.categories || []).map((c, i) => Object.fromEntries([["cat", r.t(c)], ...s.series.map((x, j) => [`s${j}`, x.values[i]])]));
      const ws = setupSheet(wb, r, sheetName(s.title, used), cols.length + 2, logoId, s.title);
      writeTable(ws, r, cols, rows, { cat: r.S.total, ...Object.fromEntries(s.series.map((x, j) => [`s${j}`, x.values.reduce((a, b) => a + b, 0)])) });
    }
  }

  if (opts.out) { await wb.xlsx.writeFile(opts.out); return opts.out; }
  return wb.xlsx.writeBuffer();
}

module.exports = { exportXlsx };
