/**
 * The single definition of "this message cannot help a recommendation".
 *
 * Shared by the ingestion gate (which refuses to store it) and the pruner
 * (which deletes it retroactively), so the two can never drift apart.
 *
 * Scope is deliberately narrow: only content that is empty BY CONSTRUCTION —
 * stickers, system placeholders, bare emoji, greetings, pure @-mentions. This
 * runs at write time and is therefore irreversible, and WhatsApp cannot refetch
 * interior history, so anything requiring judgement ("is this chatter or a
 * thesis?") belongs in the model-backed pass in lib/ai/relevance.ts, which
 * marks messages instead of destroying them.
 */

/** WhatsApp system/placeholder bodies written when a message has no text. */
const PLACEHOLDER_RE =
  /^\[(sticker|e2e_notification|notification_template|gp2|call_log|revoked|ciphertext|protocol|unknown|multi_vcard|vcard|location|poll_creation)\]$/i;

/**
 * Nothing but emoji, punctuation, whitespace or zero-width joiners.
 * NOTE: \p{Emoji_Component} includes the digits 0-9 (they are keycap bases), so
 * this alone would classify a bare "174" — a price — as decoration. Never apply
 * it to a string containing a digit; see HAS_DIGIT_RE below.
 */
const EMOJI_ONLY_RE = /^[\s\p{Extended_Pictographic}\p{Emoji_Component}\p{P}\p{S}‍️]*$/u;
const HAS_DIGIT_RE = /\d/;

/** Greetings and acknowledgements — the whole message, nothing else. */
const GREETING_ONLY_RE =
  /^(hola|buenas?(\s+(d[ií]as?|tardes?|noches?))?|buen[oa]s\s*(d[ií]as?|tardes?|noches?)?|saludos?|gm|gn|hi|hello|hey|good\s*(morning|night)|gracias|muchas\s+gracias|de\s+nada|ok+|okay|oka|dale|listo|perfecto|exacto|correcto|claro|obvio|verdad|cierto|s[ií]|no|nop|yap|ya|jaja+|jeje+|jiji+|haha+|lol|xd+|lmao|amen|am[eé]n|igualmente|bienvenid[oa]s?|hasta luego|nos vemos|chao|ciao|adi[oó]s|abrazo|saludo|bravo|excelente|genial|top|crack|maestro|grande|vamos|eso|felicitaciones|felicidades)[\s!.,¡¿?😂🤣👍🙌👏🔥💪❤️🎉]*$/iu;

/** Only @-mentions (and punctuation). */
const MENTION_ONLY_RE = /^(\s*@[\w.\-]+[\s,]*)+$/;

/** A price, a percentage, or explicit finance vocabulary. */
const FINANCE_RE =
  /\$\s?\d|\d\s?%|\busd\b|\beur\b|precio|target|stop\s?loss|\bsl\b|soporte|resistencia|comprar|vender|compr[eéo]|vend[ií]|long|short|calls?|puts?|strike|earnings|reporte|resultados|guidance|dividendo|yield|bull|bear|fibonacci|\bma\s?\d{2,3}\b|\bmm\s?\d{2,3}\b|\bema\b|\brsi\b|macd|breakout|ath\b|premarket|after\s?hours|portfolio|posici[oó]n|cartera|acci[oó]n(es)?|mercado|bolsa|[ií]ndice|\bspx\b|\bndx\b|\bvix\b|\bfed\b|\bfomc\b|tasas?|inflaci[oó]n/i;

/**
 * Candidate ticker tokens: 1–5 uppercase letters, optionally $-prefixed.
 * The `u` flag matters: without it JS treats "á" as a non-word character, so
 * "Más" yields a spurious "M" token — which is a real ticker (Macy's).
 */
const TICKER_TOKEN_RE = /\$?\b[A-Z]{1,5}\b/gu;

/** A $-sigil ticker: "$NVDA". Unambiguous, so safe to use as a hard floor. */
const EXPLICIT_TICKER_RE = /\$[A-Z]{1,5}\b/u;

/**
 * Uppercase words that are real tickers but overwhelmingly ordinary words in
 * chat. Requiring a $ prefix for these avoids treating "NO" or "YA" as tickers.
 */
const TICKER_STOPWORDS = new Set([
  "A", "AL", "AM", "AN", "AS", "AT", "BE", "BY", "DE", "DO", "E", "EL", "EN", "ES", "ET",
  "GO", "HE", "IT", "LA", "LO", "ME", "MI", "MY", "NO", "O", "OK", "ON", "OR", "PM", "SE",
  "SI", "SO", "TE", "TU", "UN", "UP", "US", "VS", "WE", "YA", "Y", "ALL", "AND", "ANY",
  "ARE", "BIG", "BUT", "CAN", "CON", "DOS", "FOR", "HAS", "HOY", "LAS", "LOS", "MAS",
  "NEW", "NOT", "NOW", "ONE", "OUT", "PER", "POR", "PRO", "QUE", "SEE", "SUN", "TWO",
  "USA", "VER", "WAS", "WHO", "YOU", "JAJA", "JEJE", "PARA", "PERO", "ESTA", "ESTE",
]);

/**
 * True when the text names a symbol in `universe`. Pass the SEC ticker set to
 * validate; pass an empty set to skip ticker protection (the caller should then
 * rely on FINANCE_RE alone, and must not delete on the result).
 */
export function hasRealTicker(body: string, universe: Set<string>): boolean {
  if (universe.size === 0) return false;
  for (const raw of body.match(TICKER_TOKEN_RE) ?? []) {
    const dollar = raw.startsWith("$");
    const sym = raw.replace(/^\$/, "");
    if (!universe.has(sym)) continue;
    // A bare "NO" is not Novo Nordisk; "$NO" is.
    if (!dollar && TICKER_STOPWORDS.has(sym)) continue;
    return true;
  }
  return false;
}

/** True when the text carries a price, a percentage or finance vocabulary. */
export function hasFinanceSignal(body: string): boolean {
  return FINANCE_RE.test(body);
}

/**
 * High-precision finance floor: only a $-sigil ticker counts as a ticker here.
 *
 * A BARE uppercase token is far too weak to override a model verdict — "GM" is
 * good morning far more often than General Motors, and short interjections are
 * riddled with such collisions. Bare tokens are exactly the ambiguity the model
 * pass exists to resolve, so they must not pre-empt it.
 */
export function hasExplicitFinanceContent(body: string): boolean {
  return FINANCE_RE.test(body) || EXPLICIT_TICKER_RE.test(body);
}

export type NoiseVerdict = { noise: false } | { noise: true; rule: string };

/**
 * Classify a message body. `universe` is optional ticker protection: when the
 * SEC list is unavailable, pass an empty set — the deterministic rules below
 * never fire on anything containing a ticker-shaped token anyway, because a
 * sticker, a bare emoji and "Gm" contain no letters in ticker position.
 */
export function classifyNoise(
  body: string | null | undefined,
  universe: Set<string> = new Set()
): NoiseVerdict {
  const t = (body ?? "").trim();
  if (!t) return { noise: true, rule: "empty" };

  // Protections win over every noise rule below.
  if (hasFinanceSignal(t)) return { noise: false };
  if (hasRealTicker(t, universe)) return { noise: false };

  if (PLACEHOLDER_RE.test(t)) return { noise: true, rule: "placeholder/sticker" };
  // Mentions first: "@150070603333867" is a mention, not emoji.
  if (MENTION_ONLY_RE.test(t)) return { noise: true, rule: "mention only" };
  // A digit anywhere disqualifies the emoji rule — a bare number is far more
  // likely to be a price or a level than decoration.
  if (!HAS_DIGIT_RE.test(t) && EMOJI_ONLY_RE.test(t))
    return { noise: true, rule: "emoji/punctuation only" };
  if (GREETING_ONLY_RE.test(t)) return { noise: true, rule: "greeting/ack only" };

  return { noise: false };
}

/** Convenience predicate for the ingestion gate. */
export function isContentlessNoise(body: string | null | undefined): boolean {
  return classifyNoise(body).noise;
}
