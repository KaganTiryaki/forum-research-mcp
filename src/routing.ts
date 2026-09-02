export type Locale = "tr" | "en";
export type LocalePreference = "auto" | Locale | "both";

const TURKISH_SIGNALS = /[çğıöşü]|\b(türkiye|türk|tl|lira|deneyimleri|nedir|nasıl|hangi|fiyat|sorun)\b/i;

export function selectInitialLocales(query: string, preference: LocalePreference = "auto"): Locale[] {
  if (preference === "tr" || preference === "en") return [preference];
  if (preference === "both") return ["tr", "en"];

  return TURKISH_SIGNALS.test(query) ? ["tr"] : ["en"];
}

export function secondaryLocale(locales: Locale[]): Locale | undefined {
  if (locales.length !== 1) return undefined;
  return locales[0] === "tr" ? "en" : "tr";
}
