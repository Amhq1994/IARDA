const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const { prepare, totalsRow, dates, t, CHART } = require("../src/common");
const { exportPptx, exportXlsx, exportPdf } = require("../src");

const spec = JSON.parse(readFileSync(join(__dirname, "../examples/camps-report.json"), "utf8"));
const NOW = "2026-11-25T10:30:00Z";

test("localized values and brand chart palette", () => {
  assert.equal(t({ ar: "مرحبا", en: "Hello" }, "en"), "Hello");
  assert.equal(t("plain", "ar"), "plain");
  assert.deepEqual(CHART, ["005337", "AE7029", "5B7172", "E5DBC8", "014F37"]);
});

test("Hijri (Umm al-Qura) and Gregorian print dates", () => {
  const d = dates(new Date(NOW), "ar");
  assert.equal(d.hijriShort, "15/06/1448");
  assert.equal(d.gregShort, "25/11/2026");
});

test("totals row sums numeric columns and skips percentages", () => {
  const sec = spec.sections.find((s) => s.type === "table");
  const tot = totalsRow(sec, "ar");
  assert.equal(tot.area, "المجموع");
  assert.equal(tot.camps, 120);
  assert.equal(tot.share, "");
});

test("prepare() rejects unknown languages", () => {
  assert.throws(() => prepare(spec, { lang: "fr" }));
});

test("PPTX: cover + one slide per section + closing, RTL, brand colours", async () => {
  const buf = await exportPptx(spec, { lang: "ar", now: NOW });
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, 2 + spec.sections.length);
  const pres = await zip.file("ppt/presentation.xml").async("string");
  assert.match(pres, /rtl="1"/);
  const last = await zip.file(`ppt/slides/slide${slides.length}.xml`).async("string");
  assert.match(last, /شكراً/);
  const table = await zip.file("ppt/slides/slide3.xml").async("string");
  assert.match(table, /005337/);
});

test("XLSX: RTL sheets, green header, live SUM totals", async () => {
  const buf = await exportXlsx(spec, { lang: "ar", now: NOW });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[1];
  assert.equal(ws.views[0].rightToLeft, true);
  assert.equal(ws.getCell("A6").fill.fgColor.argb, "FF005337");
  assert.equal(ws.getCell("B18").value.formula, "SUM(B7:B17)");
  assert.match(ws.headerFooter.oddFooter, /&P \/ &N/);
});

test("PDF: cover + content + closing pages", { skip: !hasPlaywright() }, async () => {
  const { PDFDocument } = require("pdf-lib");
  const buf = await exportPdf(spec, { lang: "en", now: NOW });
  const doc = await PDFDocument.load(buf);
  assert.ok(doc.getPageCount() >= 3);
  assert.equal(doc.getTitle(), "Northern Camps Report");
});

function hasPlaywright() {
  try { require.resolve("playwright"); return true; } catch { return false; }
}
