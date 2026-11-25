// Code 128 (set B) encoder → SVG bar widths. Enough for bin, item and lot codes (printable ASCII 32–126).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104, STOP = 106;

/** Returns module widths (bar, space, bar, …) for the value, quiet zones excluded. */
export function code128(value: string): number[] {
  const codes = [START_B];
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    codes.push(c >= 32 && c <= 126 ? c - 32 : 0);
  }
  const check = codes.reduce((s, c, i) => s + c * (i === 0 ? 1 : i), 0) % 103;
  codes.push(check, STOP);
  return codes.flatMap((c) => PATTERNS[c].split("").map(Number));
}

/** SVG markup for the barcode (height in px, module = 1 unit; scales with the viewBox). */
export function code128Svg(value: string, height = 50): string {
  const w = code128(value);
  const total = w.reduce((a, b) => a + b, 0) + 20;
  let x = 10, bars = "";
  w.forEach((m, i) => { if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${m}" height="${height}"/>`; x += m; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" fill="#000">${bars}</svg>`;
}
