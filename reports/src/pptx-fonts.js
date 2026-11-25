// Copies the embedded fonts (SF Mada, Cocon Next Arabic) from the official IARDA
// PowerPoint template into a generated deck, so it renders with the brand fonts on
// machines that don't have them installed — exactly like the template itself.
//
// The font data is read from the template at export time and is never stored in
// this repository. Point to the template with:
//   IARDA_PPTX_FONT_SOURCE=/secure/path/iarda-template.pptx   (or opts.fontSource)
const { readFileSync, writeFileSync } = require("node:fs");
const JSZip = require("jszip");

const FONT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";

async function embedFontsFromTemplate(deckPath, templatePath) {
  const tpl = await JSZip.loadAsync(readFileSync(templatePath));
  const tplPres = await tpl.file("ppt/presentation.xml").async("string");
  const tplRels = await tpl.file("ppt/_rels/presentation.xml.rels").async("string");
  const lst = tplPres.match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/);
  if (!lst) return false;

  const relTarget = {};
  for (const m of tplRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    const target = m[0].match(/Target="([^"]+)"/)?.[1];
    if (m[0].includes(FONT_REL)) relTarget[id] = target;
  }

  const deck = await JSZip.loadAsync(readFileSync(deckPath));
  let pres = await deck.file("ppt/presentation.xml").async("string");
  let rels = await deck.file("ppt/_rels/presentation.xml.rels").async("string");
  let types = await deck.file("[Content_Types].xml").async("string");
  if (pres.includes("<p:embeddedFontLst>")) return false;

  let n = 0;
  const idMap = {};
  for (const [oldId, target] of Object.entries(relTarget)) {
    const data = await tpl.file(`ppt/${target}`).async("nodebuffer");
    const newId = `rIdIardaFont${++n}`;
    const newTarget = `fonts/iarda-font${n}.fntdata`;
    deck.file(`ppt/${newTarget}`, data);
    rels = rels.replace("</Relationships>", `<Relationship Id="${newId}" Type="${FONT_REL}" Target="${newTarget}"/></Relationships>`);
    idMap[oldId] = newId;
  }
  const newLst = lst[0].replace(/r:id="([^"]+)"/g, (_, id) => `r:id="${idMap[id] || id}"`);

  // <p:embeddedFontLst> belongs right after <p:notesSz/> (schema order).
  pres = pres.replace(/(<p:notesSz\b[^>]*\/>)/, `$1${newLst}`);
  if (!/embedTrueTypeFonts=/.test(pres)) pres = pres.replace(/<p:presentation\b/, '<p:presentation embedTrueTypeFonts="1"');
  if (!/saveSubsetFonts=/.test(pres)) pres = pres.replace(/<p:presentation\b/, '<p:presentation saveSubsetFonts="1"');
  if (!types.includes('Extension="fntdata"')) {
    types = types.replace("<Default ", '<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default ');
  }

  deck.file("ppt/presentation.xml", pres);
  deck.file("ppt/_rels/presentation.xml.rels", rels);
  deck.file("[Content_Types].xml", types);
  writeFileSync(deckPath, await deck.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await stripDirEntries(deckPath);
  return true;
}

/** Rewrites the zip without folder entries (some cloud viewers refuse those). */
async function stripDirEntries(path) {
  const src = await JSZip.loadAsync(readFileSync(path));
  const out = new JSZip();
  for (const [name, f] of Object.entries(src.files)) if (!f.dir) out.file(name, await f.async("nodebuffer"), { createFolders: false });
  writeFileSync(path, await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

module.exports = { embedFontsFromTemplate, stripDirEntries };
