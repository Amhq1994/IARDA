// Turns dist/index.html into the artifact page: the publisher adds the <!doctype>/<html>/<head>/<body> skeleton,
// so the page keeps only its title, metas, styles, markup and scripts (language and direction set by script).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const dist = new URL("../dist/", import.meta.url);
let html = readFileSync(new URL("index.html", dist), "utf8");
html = html
  .replace(/<!doctype html>/i, "")
  .replace(/<\/?html[^>]*>/gi, "")
  .replace(/<\/?head>/gi, "")
  .replace(/<\/?body>/gi, "")
  .replace(/<meta charset="UTF-8"\s*\/?>/i, "")
  .replace(/<meta name="viewport"[^>]*>/i, "");
html = `<script>document.documentElement.lang = "ar"; document.documentElement.dir = "rtl";</script>\n` + html.trim();
const title = /<title>[\s\S]*?<\/title>/i.exec(html)[0];
html = title + "\n" + html.replace(title, "");
writeFileSync(new URL("page.html", dist), html + "\n");
console.log("page.html", html.length, "bytes");

// binary assets → base64 text (the artifact host serves only web file types)
for (const f of readdirSync(new URL("assets/", dist))) {
  if (!/\.(gz|data)$/.test(f)) continue;
  const b = readFileSync(new URL(`assets/${f}`, dist));
  writeFileSync(new URL(`assets/${f}.b64.txt`, dist), b.toString("base64"));
  console.log("base64", f, b.length, "→", Math.ceil(b.length / 3) * 4);
}
