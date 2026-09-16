/**
 * Company-event input for the analysis pipeline.
 *
 * The corpus is WhatsApp-only, so the pipeline had no way to know a company had
 * reported. That blind spot produced real errors: CIEN, GLW and LRCX all had
 * SELLs asserting "no recovery catalyst" written days after strong earnings, and
 * a CRDO BUY zone 42% above market because the entry was cached from before the
 * print. This module supplies the missing signal from SEC EDGAR — free, no key,
 * and authoritative about *whether* an event happened.
 *
 * Deliberately narrow: it reports that a filing exists, its form type and date,
 * and a link. It does NOT parse financials. The point is to stop the model
 * writing "no news" when an 8-K landed last week; interpreting the numbers is
 * the analyst's job with the link in hand.
 *
 * SEC asks for a descriptive User-Agent with a contact. Set SEC_USER_AGENT.
 */

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "stock-recommender/1.0 (set SEC_USER_AGENT for contact)";

/** Forms worth surfacing: periodic reports and material-event disclosures. */
const FORMS_OF_INTEREST = new Set(["8-K", "10-Q", "10-K", "8-K/A", "10-Q/A", "10-K/A"]);

export interface FilingEvent {
  ticker: string;
  form: string;
  filingDate: string; // YYYY-MM-DD
  items: string | null; // 8-K item codes, e.g. "2.02,7.01" — 2.02 = results of operations
  url: string;
}

// ── ticker → CIK map (cached for the process lifetime) ────────────────────────

let cikMap: Map<string, string> | null = null;
let cikMapAt = 0;
const CIK_TTL_MS = 24 * 60 * 60 * 1000;

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikMap && Date.now() - cikMapAt < CIK_TTL_MS) return cikMap;
  const res = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`SEC ticker map ${res.status}`);
  // Shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const data = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const map = new Map<string, string>();
  for (const row of Object.values(data)) {
    if (row?.ticker) map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0"));
  }
  cikMap = map;
  cikMapAt = Date.now();
  return map;
}

/**
 * Every ticker SEC EDGAR knows about. Used to tell a real symbol from an
 * ordinary uppercase word before deleting a message as noise.
 * Returns an empty set on failure — callers must treat that as "do not proceed".
 */
export async function loadTickerUniverse(): Promise<Set<string>> {
  try {
    return new Set((await loadCikMap()).keys());
  } catch {
    return new Set();
  }
}

// ── recent filings ────────────────────────────────────────────────────────────

async function filingsForTicker(
  ticker: string,
  cik: string,
  since: string
): Promise<FilingEvent[]> {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    filings?: {
      recent?: {
        accessionNumber?: string[];
        filingDate?: string[];
        form?: string[];
        primaryDocument?: string[];
        items?: string[];
      };
    };
  };
  const recent = data.filings?.recent;
  if (!recent?.form || !recent.filingDate) return [];

  const out: FilingEvent[] = [];
  const cikPlain = String(Number(cik));
  for (let i = 0; i < recent.form.length; i++) {
    const filingDate = recent.filingDate[i];
    // `recent` is newest-first, so the first row older than the window ends it.
    if (!filingDate || filingDate < since) break;
    const form = recent.form[i];
    if (!FORMS_OF_INTEREST.has(form)) continue;

    const accession = (recent.accessionNumber?.[i] ?? "").replace(/-/g, "");
    const doc = recent.primaryDocument?.[i] ?? "";
    out.push({
      ticker,
      form,
      filingDate,
      items: recent.items?.[i] || null,
      url:
        accession && doc
          ? `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accession}/${doc}`
          : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}`,
    });
  }
  return out;
}

/**
 * Recent SEC filings for the given tickers. Fully fail-safe: any network or
 * parse failure yields fewer rows, never an exception — a missing filings block
 * must never break the analysis.
 */
export async function fetchRecentFilings(
  tickers: string[],
  sinceDaysAgo = 45
): Promise<FilingEvent[]> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()))];
  if (unique.length === 0) return [];

  let map: Map<string, string>;
  try {
    map = await loadCikMap();
  } catch {
    return [];
  }

  const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString().slice(0, 10);

  const results = await Promise.all(
    unique.map(async (t) => {
      const cik = map.get(t);
      if (!cik) return []; // ETFs and foreign tickers have no CIK here
      try {
        return await filingsForTicker(t, cik, since);
      } catch {
        return [];
      }
    })
  );

  return results
    .flat()
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate) || a.ticker.localeCompare(b.ticker));
}

/** An earnings release: a periodic report, or an 8-K carrying item 2.02. */
function isResults(f: FilingEvent): boolean {
  return f.form.startsWith("10-") || (f.items?.includes("2.02") ?? false);
}

/**
 * Cap rows per ticker so one prolific filer cannot crowd out the block —
 * BMNR alone files routine item-7.01 Reg FD 8-Ks most weeks. Results always
 * survive; the remaining slots go to the most recent other filings.
 */
const MAX_ROWS_PER_TICKER = 4;

function capPerTicker(filings: FilingEvent[]): FilingEvent[] {
  const byTicker = new Map<string, FilingEvent[]>();
  for (const f of filings) {
    const list = byTicker.get(f.ticker) ?? [];
    list.push(f);
    byTicker.set(f.ticker, list);
  }

  const kept = new Set<FilingEvent>();
  for (const list of byTicker.values()) {
    // `filings` arrives newest-first, so each list already is.
    let n = 0;
    // Results are never dropped, even if a ticker has more than the cap.
    for (const f of list) if (isResults(f)) { kept.add(f); n++; }
    for (const f of list) {
      if (n >= MAX_ROWS_PER_TICKER) break;
      if (kept.has(f)) continue;
      kept.add(f);
      n++;
    }
  }
  return filings.filter((f) => kept.has(f));
}

/** Render filings as a prompt block. Empty string when there is nothing to say. */
export function renderFilingsBlock(filings: FilingEvent[], sinceDaysAgo = 45): string {
  if (filings.length === 0) return "";
  const rows = capPerTicker(filings)
    .map((f) => {
      // 8-K Item 2.02 is "Results of Operations and Financial Condition" — an
      // earnings release. Worth calling out by name; the model won't know the
      // item taxonomy.
      return `${f.ticker}|${f.filingDate}|${f.form}${isResults(f) ? " ← RESULTS" : ""}|${f.items ?? "—"}|${f.url}`;
    })
    .join("\n");

  return (
    `\n## Company filings — SEC EDGAR, last ${sinceDaysAgo} days [OUTSIDE THE CORPUS]\n` +
    "These are real company events the WhatsApp groups may never have discussed. If a ticker " +
    "appears here you may NOT describe it as having 'no catalyst', 'no news' or 'no recovery " +
    "signal' — an event exists. Rows marked ← RESULTS are earnings (10-Q/10-K, or 8-K item 2.02). " +
    "The filing contents are NOT included: say that the event occurred, that its numbers are " +
    "outside this corpus, and factor the uncertainty into confidence rather than assuming silence.\n" +
    "Ticker|Date|Form|Items|Link\n---|---|---|---|---\n" +
    rows +
    "\n"
  );
}
