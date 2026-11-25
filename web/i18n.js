// Arabic (default, RTL) ⇄ English (LTR) toggle for the reference screens.
// Any element with data-en="…" swaps its text; data-alt-en swaps an <img> alt.
(function () {
  const KEY = "iarda.lang";
  const html = document.documentElement;

  function apply(lang) {
    html.lang = lang;
    html.dir = lang === "ar" ? "rtl" : "ltr";
    document.querySelectorAll("[data-en]").forEach((el) => {
      if (!("ar" in el.dataset)) el.dataset.ar = el.textContent;
      el.textContent = lang === "ar" ? el.dataset.ar : el.dataset.en;
    });
    document.querySelectorAll("[data-alt-en]").forEach((el) => {
      if (!("altAr" in el.dataset)) el.dataset.altAr = el.alt;
      el.alt = lang === "ar" ? el.dataset.altAr : el.dataset.altEn;
    });
    document.querySelectorAll("[data-lang-toggle]").forEach((b) => (b.textContent = lang === "ar" ? "English" : "العربية"));
    try { localStorage.setItem(KEY, lang); } catch (_) {}
  }

  let initial = "ar";
  try { initial = localStorage.getItem(KEY) || "ar"; } catch (_) {}
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "ar") initial = q;
  apply(initial);

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-lang-toggle]");
    if (t) apply(html.lang === "ar" ? "en" : "ar");
    const m = e.target.closest(".menu-toggle");
    if (m) document.querySelector(".app-sidebar")?.classList.toggle("is-open");
  });
})();
