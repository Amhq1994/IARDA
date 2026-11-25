#!/usr/bin/env node
// IARDA report exporter CLI
//   node reports/cli.js <spec.json> [--lang ar|en] [--format pdf,pptx,xlsx] [--out dir]
//                       [--user "Name"] [--classification internal|public|restricted|confidential|secret]
const { readFileSync, mkdirSync } = require("node:fs");
const { join, basename } = require("node:path");
const { exportReport } = require("./src");

function parse(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
    else a._.push(argv[i]);
  }
  return a;
}

(async () => {
  const args = parse(process.argv.slice(2));
  if (!args._[0] || args.help) {
    console.log("usage: iarda-report <spec.json> [--lang ar|en] [--format pdf,pptx,xlsx] [--out dir] [--user name] [--classification level]");
    process.exit(args.help ? 0 : 1);
  }
  const spec = JSON.parse(readFileSync(args._[0], "utf8"));
  if (args.user) spec.generatedBy = args.user;
  if (args.classification) spec.classification = args.classification;
  const lang = args.lang || "ar";
  const outDir = args.out || "reports/out";
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${spec.id || basename(args._[0], ".json")}-${lang}`);
  const formats = String(args.format || "pdf,pptx,xlsx").split(",");
  const files = await exportReport(spec, { lang, formats, base, now: args.date });
  files.forEach((f) => console.log("wrote", f));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
