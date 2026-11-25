// Public API of the IARDA report exporter.
//   const { exportReport } = require("iarda-brand");
//   await exportReport(spec, { lang: "ar", formats: ["pdf", "pptx", "xlsx"], base: "out/my-report" });
const { exportPdf } = require("./pdf");
const { exportPptx } = require("./pptx");
const { exportXlsx } = require("./xlsx");

const EXPORTERS = { pdf: exportPdf, pptx: exportPptx, xlsx: exportXlsx };

async function exportReport(spec, { lang = "ar", formats = ["pdf", "pptx", "xlsx"], base, now } = {}) {
  const written = [];
  for (const f of formats) {
    const fn = EXPORTERS[f.trim()];
    if (!fn) throw new Error(`Unknown format "${f}" (use pdf, pptx, xlsx)`);
    const out = `${base}.${f.trim()}`;
    await fn(spec, { lang, out, now });
    written.push(out);
  }
  return written;
}

module.exports = { exportReport, exportPdf, exportPptx, exportXlsx };
