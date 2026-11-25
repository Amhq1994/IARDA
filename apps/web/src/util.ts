import { useTranslation } from "react-i18next";

/** Picks name_ar / name_en (or any prefix) according to the current language. */
export function useL() {
  const { i18n } = useTranslation();
  const ar = i18n.language === "ar";
  return (row: any, prefix = "name") => (row ? (ar ? row[`${prefix}_ar`] ?? row[`${prefix}Ar`] : row[`${prefix}_en`] ?? row[`${prefix}En`]) ?? "" : "");
}

/** Hijri (Umm al-Qura) first, Gregorian second — per approved setting. */
export function fmtDate(iso: string | null | undefined, lang: string, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const loc = lang === "ar" ? "ar-SA" : "en-GB";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const h = new Intl.DateTimeFormat(`${loc}-u-ca-islamic-umalqura-nu-latn`, opts).format(d);
  const g = new Intl.DateTimeFormat(`${loc}-u-ca-gregory-nu-latn`, opts).format(d);
  const time = withTime ? " " + new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d) : "";
  return `${h} · ${g}${time}`;
}

export const fmtNum = (n: number | null | undefined, max = 2) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: max }).format(n);

export const fmtSar = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${fmtNum(n, 2)} ر.س`);

export const pct = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 100) : 0);

export function errorText(e: any, lang: string): string {
  if (!e) return "";
  if (typeof e.message_for === "function") {
    const base = e.message_for(lang);
    const d = e.body?.details;
    if (Array.isArray(d) && d.length && d[0].path !== undefined) return `${base}: ${d.map((x: any) => `${x.path} (${x.message})`).join("، ")}`;
    return base;
  }
  return String(e.message ?? e);
}
