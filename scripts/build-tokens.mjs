// Generates brand/css/tokens.css and reports/src/tokens.generated.js from brand/tokens.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = JSON.parse(readFileSync(join(root, "brand/tokens.json"), "utf8"));

const kebab = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const lines = [];
for (const [k, v] of Object.entries(t.color)) lines.push(`  --iarda-${kebab(k)}: ${v};`);
t.chart.forEach((c, i) => lines.push(`  --iarda-chart-${i + 1}: ${c};`));
lines.push(`  --iarda-gradient: ${t.gradient.brand};`);
lines.push(`  --iarda-font: ${t.font.primary};`);
lines.push(`  --iarda-font-display: ${t.font.display};`);
lines.push(`  --iarda-radius: ${t.radius};`);
for (const [k, v] of Object.entries(t.shadow)) lines.push(`  --iarda-shadow-${k}: ${v};`);
for (const [k, v] of Object.entries(t.space)) lines.push(`  --iarda-space-${k}: ${v};`);

const header = "/* GENERATED from brand/tokens.json by scripts/build-tokens.mjs — do not edit by hand. */\n";
writeFileSync(join(root, "brand/css/tokens.css"), `${header}:root {\n${lines.join("\n")}\n}\n`);
writeFileSync(
  join(root, "reports/src/tokens.generated.js"),
  `${header.replace("/*", "//").replace(" */", "")}module.exports = ${JSON.stringify(t, null, 2)};\n`
);
console.log("tokens: wrote brand/css/tokens.css and reports/src/tokens.generated.js");
