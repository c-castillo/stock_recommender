/**
 * The macro topics the bundle tracks, and the words the groups use for them.
 *
 * A report or PDF that helps read the macro picture (a CPI note, a CTA-flow
 * model, a midterm liquidity study) is not a trading idea and is not thrown
 * away: its digest carries `macro` notes under one of these topics, and the
 * bundle prints them next to what the WhatsApp groups said on the same topic.
 * No network and no database.
 */

export const MACRO_TOPICS = [
  "Fed, rates and yields",
  "Inflation and data",
  "Growth and earnings",
  "Positioning, flows and volatility",
  "Liquidity and credit",
  "Politics and midterms",
  "AI capex and the semis cycle",
  "Oil, commodities and FX",
  "Market trend and technical read",
] as const;

export type MacroTopic = (typeof MACRO_TOPICS)[number];

const WORDS: Record<MacroTopic, RegExp> = {
  "Fed, rates and yields": /\b(fed|fomc|powell|warsh|waller|tasas?|rates?|yields?|10y|10 ?yr|treasur\w*|bonos?|hike|hawkish|dovish)\b/i,
  "Inflation and data": /\b(cpi|ppi|pce|inflaci\w*|inflation|payrolls?|nfp|jobs|empleo|desempleo|unemployment|ism|retail sales)\b/i,
  "Growth and earnings": /\b(gdp|pib|recession|recesi\w*|earnings|resultados|guidance|eps|revisions?|revisiones)\b/i,
  "Positioning, flows and volatility": /\b(cta|vix|vvix|gamma|positioning|posicionamiento|flujos?|flows?|opex|0dte|volatility|volatilidad|buybacks?|systematic|sistem[aá]tic\w*)\b/i,
  "Liquidity and credit": /\b(liquidity|liquidez|credit|cr[eé]dito|cds|spreads?|high yield|hyg|funding|repo|tga)\b/i,
  "Politics and midterms": /\b(midterms?|elecciones|election|trump|congress|congreso|senate|senado|tariffs?|aranceles?|shutdown|moratori\w*)\b/i,
  "AI capex and the semis cycle": /\b(capex|hyperscal\w*|data ?cent\w*|semis?|semiconductor\w*|soxx?|smh|nvda|nvidia|hbm|dram|neocloud\w*)\b/i,
  "Oil, commodities and FX": /\b(oil|wti|brent|crudo|petr[oó]leo|gold|oro|copper|cobre|dxy|d[oó]lar|dollar|fx|yen|yuan)\b/i,
  "Market trend and technical read": /\b(spx|s&p ?500|ndx|nasdaq|200 ?dma|200 ?d[ií]as|breadth|amplitud|soporte|resistencia|support|resistance|correcci[oó]n|correction|rebote|bounce)\b/i,
};

/** The topics a text is about (it can be about several). */
export function macroTopicsOf(text: string): MacroTopic[] {
  return MACRO_TOPICS.filter((t) => WORDS[t].test(text));
}

/** A topic a digest wrote loosely ("Fed / rates") mapped to the closest of ours, or null. */
export function normalizeMacroTopic(raw: string): MacroTopic | null {
  const exact = MACRO_TOPICS.find((t) => t.toLowerCase() === raw.trim().toLowerCase());
  if (exact) return exact;
  const hits = macroTopicsOf(raw);
  return hits.length === 1 ? hits[0] : hits[0] ?? null;
}
