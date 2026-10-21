/**
 * A Chilean issuer's statements as it files them with the CMF in XBRL, and
 * what the analysis reads off them: where the profit comes from (the business,
 * or tax, exchange-rate, indexation, revaluation and one-off lines) and the
 * valuation (P/E, P/B, ROE) on trailing twelve months.
 *
 * Chilean statements are year-to-date: March is 3 months, June 6, September 9,
 * December 12. Each filing carries the same period of the year before, so
 * twelve months = this year-to-date + last December's year − last year's
 * same year-to-date, which needs this filing and last December's.
 *
 * Banks file under the banking registry, outside this format: they have none.
 */

/** Flows read from the income and cash-flow statements (IFRS taxonomy unless
 *  prefixed). Most issuers file by function; an issuer that leaves a line out
 *  simply has none. */
export const FLOW_CONCEPTS = [
  "Revenue", "CostOfSales", "GrossProfit", "DistributionCosts", "AdministrativeExpense",
  "OtherIncome", "OtherExpenseByFunction", "OtherGainsLosses", "ProfitLossFromOperatingActivities",
  "FinanceIncome", "FinanceCosts", "ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod",
  "GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss", "GainsLossesOnNetMonetaryPosition",
  "GainsLossesOnChangeInFairValueEstimatesOfBiologicalAssetsForCurrentPeriod",
  "ImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss",
  "ProfitLossBeforeTax", "IncomeTaxExpenseContinuingOperations", "CurrentTaxExpenseIncome",
  "CurrentTaxExpenseIncomeAndAdjustmentsForCurrentTaxOfPriorPeriods",
  "DeferredTaxExpenseIncomeRecognisedInProfitOrLoss", "DeferredTaxExpenseIncome",
  "DeferredTaxExpenseIncomeRelatingToOriginationAndReversalOfTemporaryDifferences",
  "ProfitLossFromDiscontinuedOperations", "ProfitLoss", "ProfitLossAttributableToOwnersOfParent",
  "BasicEarningsLossPerShare", "DepreciationAndAmortisationExpense",
  "CashFlowsFromUsedInOperatingActivities", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
  "DividendsPaidClassifiedAsFinancingActivities",
  // The CMF's own line on the face of the statement: "Resultados por
  // unidades de reajuste", the inflation indexation of UF-denominated items.
  "ResultadosUnidadesReajuste",
] as const;
export const STOCK_CONCEPTS = [
  "Assets", "Liabilities", "CurrentAssets", "CurrentLiabilities", "Equity", "EquityAttributableToOwnersOfParent",
  "CashAndCashEquivalents", "OtherCurrentFinancialLiabilities", "OtherNoncurrentFinancialLiabilities",
  "DeferredTaxAssets", "DeferredTaxLiabilities",
] as const;
export type FlowConcept = (typeof FLOW_CONCEPTS)[number];
export type StockConcept = (typeof STOCK_CONCEPTS)[number];

export interface CmfStatements {
  /** "YYYY-MM", the period's closing month. */
  period: string;
  /** C consolidated, I individual (an issuer without subsidiaries). */
  tipo: "C" | "I";
  /** ISO code of the presentation currency: most file in CLP, exporters in USD. */
  currency: string;
  /** Flows by "start/end": the year-to-date, the quarter, and the same two a year earlier. */
  flows: Record<string, Partial<Record<FlowConcept, number>>>;
  /** Balances by date: the period's end and last December's. */
  stocks: Record<string, Partial<Record<StockConcept, number>>>;
}

const FLOWS = new Set<string>(FLOW_CONCEPTS);
const STOCKS = new Set<string>(STOCK_CONCEPTS);

/** The non-dimensional facts of one filing's instance document. A context
 *  with a segment or scenario (a breakdown by member) is skipped: only the
 *  statements' own totals are kept. Filing software differs (attributes come
 *  in either quote, contexts are named p1_Duration or AcumuladoActual), so
 *  contexts are known by their dates, never by their names. */
export function parseXbrl(xml: string, period: string, tipo: "C" | "I"): CmfStatements {
  const contexts = new Map<string, { key: string; instant: boolean }>();
  for (const m of xml.matchAll(/<xbrli:context\s+id=["']([^"']+)["']\s*>([\s\S]*?)<\/xbrli:context>/g)) {
    if (/<xbrli:(segment|scenario)/.test(m[2])) continue;
    const instant = m[2].match(/<xbrli:instant>([^<]+)</)?.[1];
    const start = m[2].match(/<xbrli:startDate>([^<]+)</)?.[1];
    const end = m[2].match(/<xbrli:endDate>([^<]+)</)?.[1];
    if (instant) contexts.set(m[1], { key: instant, instant: true });
    else if (start && end) contexts.set(m[1], { key: `${start}/${end}`, instant: false });
  }
  const units = new Map<string, string>();
  for (const m of xml.matchAll(/<xbrli:unit\s+id=["']([^"']+)["']\s*>\s*<xbrli:measure>\s*iso4217:([A-Z]{3})\s*<\/xbrli:measure>/g)) units.set(m[1], m[2]);

  const out: CmfStatements = { period, tipo, currency: "", flows: {}, stocks: {} };
  const seen = new Map<string, number>();
  for (const m of xml.matchAll(/<(ifrs-full|cl-ci):([A-Za-z]+)\s([^>]*?)>([^<]*)<\/\1:\2>/g)) {
    const [, , name, attrs, raw] = m;
    if (!FLOWS.has(name) && !STOCKS.has(name)) continue;
    const ctx = contexts.get(attrs.match(/contextRef=["']([^"']+)["']/)?.[1] ?? "");
    const value = Number(raw.trim());
    if (!ctx || !isFinite(value)) continue;
    const unit = units.get(attrs.match(/unitRef=["']([^"']+)["']/)?.[1] ?? "");
    if (unit && !out.currency && (name === "Revenue" || name === "ProfitLoss" || name === "Assets")) out.currency = unit;
    const bucket = ctx.instant ? (out.stocks[ctx.key] ??= {}) : (out.flows[ctx.key] ??= {});
    // A fact filed twice in one context (it happens) keeps its first value.
    const id = `${ctx.key}|${name}`;
    if (seen.has(id)) continue;
    seen.set(id, value);
    (bucket as Record<string, number>)[name] = value;
  }
  return out;
}

// ── What the analysis reads ──────────────────────────────────────────────────

type Flow = Partial<Record<FlowConcept, number>>;

const months = (key: string) => {
  const [s, e] = key.split("/");
  return (Number(e.slice(0, 4)) - Number(s.slice(0, 4))) * 12 + Number(e.slice(5, 7)) - Number(s.slice(5, 7)) + 1;
};

/** The year-to-date of a filing (and of the year before), its quarter (and the
 *  year before's), picked by length: a June filing's year-to-date is 6 months. */
export function periodsOf(s: CmfStatements): { ytd?: Flow; ytdPrior?: Flow; q?: Flow; qPrior?: Flow; ytdMonths: number } {
  const ytdMonths = Number(s.period.slice(5, 7));
  const end = (y: number) => `${y}-${s.period.slice(5, 7)}`;
  const year = Number(s.period.slice(0, 4));
  const pick = (y: number, len: number) => {
    const k = Object.keys(s.flows).find((key) => key.split("/")[1].startsWith(end(y)) && months(key) === len);
    return k ? s.flows[k] : undefined;
  };
  return {
    ytd: pick(year, ytdMonths), ytdPrior: pick(year - 1, ytdMonths),
    q: ytdMonths > 3 ? pick(year, 3) : undefined, qPrior: ytdMonths > 3 ? pick(year - 1, 3) : undefined,
    ytdMonths,
  };
}

/** Twelve months to the filing's end: this year-to-date + last December's year
 *  − last year's same year-to-date. A December filing is its own twelve months. */
export function trailing(cur: CmfStatements, december: CmfStatements | null): Flow | null {
  const p = periodsOf(cur);
  if (!p.ytd) return null;
  if (p.ytdMonths === 12) return p.ytd;
  const fy = december ? periodsOf(december).ytd : undefined;
  if (!fy || !p.ytdPrior) return null;
  const out: Flow = {};
  for (const c of FLOW_CONCEPTS) {
    const [a, b, d] = [p.ytd[c], fy[c], p.ytdPrior[c]];
    if (a != null && b != null && d != null) out[c] = a + b - d;
  }
  return out;
}

/** Where a period's profit came from, before tax, in the filing's currency.
 *  "Business" is the result of running the company: gross profit less selling
 *  and administrative costs for an issuer that files by function; for one
 *  that files by nature (the utilities), profit before tax less every line
 *  named below. The other lines are what a buyer of the shares should not pay
 *  a multiple for, or should at least see. `unexplained` is what the named
 *  lines leave over against profit before tax: large, and the split is off. */
export interface ProfitSources {
  business: number | null;
  otherOperating: number | null;   // other income, other expenses, other gains/losses
  finance: number | null;          // finance income − finance costs
  associates: number | null;
  fx: number | null;               // exchange differences
  indexation: number | null;       // unidades de reajuste (inflation indexation)
  biological: number | null;       // fair value of biological assets
  unexplained: number | null;
  beforeTax: number | null;
  tax: number | null;              // expense, positive; a negative tax is a credit that lifts profit
  /** The deferred part of the tax: filed, or the tax less its current part. */
  deferredTax: number | null;
  net: number | null;
  netToOwners: number | null;
}

export function profitSources(f: Flow): ProfitSources {
  const v = (x: number | undefined) => x ?? null;
  const sum = (...xs: (number | null)[]) => (xs.every((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));
  const finance = sum(v(f.FinanceIncome), f.FinanceCosts != null ? -f.FinanceCosts : null);
  const associates = v(f.ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod);
  const fx = v(f.GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss);
  const indexation = f.ResultadosUnidadesReajuste ?? f.GainsLossesOnNetMonetaryPosition ?? null;
  const biological = v(f.GainsLossesOnChangeInFairValueEstimatesOfBiologicalAssetsForCurrentPeriod);
  const beforeTax = v(f.ProfitLossBeforeTax);
  const byFunction = f.GrossProfit != null;
  // Forestry files the revaluation of its plantations inside other income.
  const otherOperating = byFunction
    ? sum(v(f.OtherIncome), f.OtherExpenseByFunction != null ? -f.OtherExpenseByFunction : null, v(f.OtherGainsLosses), biological != null ? -biological : null)
    : v(f.OtherGainsLosses);
  const named = sum(otherOperating, finance, associates, fx, indexation, biological);
  const business = byFunction
    ? f.GrossProfit! - (f.DistributionCosts ?? 0) - (f.AdministrativeExpense ?? 0)
    : beforeTax != null ? beforeTax - (named ?? 0) : null;
  const tax = v(f.IncomeTaxExpenseContinuingOperations);
  const current = f.CurrentTaxExpenseIncomeAndAdjustmentsForCurrentTaxOfPriorPeriods ?? f.CurrentTaxExpenseIncome;
  return {
    business, otherOperating, finance, associates, fx, indexation, biological,
    unexplained: byFunction && beforeTax != null && business != null ? beforeTax - business - (named ?? 0) : null,
    beforeTax,
    tax,
    deferredTax: f.DeferredTaxExpenseIncomeRecognisedInProfitOrLoss ?? f.DeferredTaxExpenseIncome
      ?? f.DeferredTaxExpenseIncomeRelatingToOriginationAndReversalOfTemporaryDifferences
      ?? (tax != null && current != null ? tax - current : null),
    net: v(f.ProfitLoss),
    netToOwners: v(f.ProfitLossAttributableToOwnersOfParent),
  };
}

export interface Valuation {
  /** Shares implied by profit to owners over basic EPS, year-to-date: every
   *  series together, so for a two-series issuer (ANDINA, SQM) P/B prices all
   *  of them at the held series' price. */
  shares: number | null;
  /** Twelve months' EPS, in CLP. */
  epsTtm: number | null;
  pe: number | null;
  pb: number | null;
  /** Twelve months' profit to owners over owners' equity at the period end. */
  roe: number | null;
  /** The same ROE with the business result alone, after a 27% tax: what the
   *  company earns on its equity without the accounting lines. */
  roeBusiness: number | null;
  /** Operating cash flow over net profit, twelve months. */
  cashConversion: number | null;
  /** Financial debt less cash, over owners' equity. */
  netDebtToEquity: number | null;
  /** CLP per unit of the filing's currency used (1 for CLP). */
  fx: number;
}

/** Chile's first-category corporate tax rate. */
export const CL_TAX = 0.27;

export function valuation(cur: CmfStatements, ttm: Flow | null, price: number, usdClp: number | null): Valuation | null {
  const fx = cur.currency === "CLP" ? 1 : cur.currency === "USD" && usdClp ? usdClp : null;
  if (fx == null) return null;
  const { ytd } = periodsOf(cur);
  const eqKey = Object.keys(cur.stocks).sort().at(-1);
  const st = eqKey ? cur.stocks[eqKey] : {};
  const equity = st.EquityAttributableToOwnersOfParent ?? null;
  const shares = ytd?.ProfitLossAttributableToOwnersOfParent && ytd.BasicEarningsLossPerShare
    ? ytd.ProfitLossAttributableToOwnersOfParent / ytd.BasicEarningsLossPerShare
    : null;
  const ni = ttm?.ProfitLossAttributableToOwnersOfParent ?? null;
  const eps = ni != null && shares ? (ni * fx) / shares : null;
  const biz = ttm ? profitSources(ttm).business : null;
  const debt = st.OtherCurrentFinancialLiabilities != null || st.OtherNoncurrentFinancialLiabilities != null
    ? (st.OtherCurrentFinancialLiabilities ?? 0) + (st.OtherNoncurrentFinancialLiabilities ?? 0) - (st.CashAndCashEquivalents ?? 0)
    : null;
  return {
    shares,
    epsTtm: eps,
    pe: eps && eps > 0 ? price / eps : null,
    pb: equity && shares ? (price * shares) / (equity * fx) : null,
    roe: ni != null && equity ? ni / equity : null,
    roeBusiness: biz != null && equity ? (biz * (1 - CL_TAX)) / equity : null,
    cashConversion: ttm?.CashFlowsFromUsedInOperatingActivities != null && ttm.ProfitLoss ? ttm.CashFlowsFromUsedInOperatingActivities / ttm.ProfitLoss : null,
    netDebtToEquity: debt != null && equity ? debt / equity : null,
    fx,
  };
}

// ── The bundle's view ────────────────────────────────────────────────────────

const mm = (x: number | null | undefined) =>
  x == null || !isFinite(x) ? "—" : Math.round(x / 1e6).toLocaleString("es-CL");
const pct = (x: number | null | undefined, d = 1) => (x == null || !isFinite(x) ? "—" : `${(100 * x).toFixed(d)}%`);
const chg = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !b ? "—" : `${a - b >= 0 ? "+" : ""}${((100 * (a - b)) / Math.abs(b)).toFixed(0)}%`;
const n2 = (x: number | null | undefined) => (x == null || !isFinite(x) ? "—" : x.toLocaleString("es-CL", { maximumFractionDigits: 2 }));

/** Earnings-quality flags: where the profit is not the business's, and where
 *  the growth is not. Thresholds are the playbook's EARNINGS QUALITY rule. */
export function qualityFlags(ttm: ProfitSources | null, ytd: ProfitSources, ytdPrior: ProfitSources | null, v: Valuation | null): string[] {
  const out: string[] = [];
  const base = ttm ?? ytd;
  const span = ttm ? "over 12 months" : "year to date";
  const pbt = base.beforeTax;
  if (pbt != null && pbt !== 0) {
    // Interest and associates recur; these are the accounting and one-off lines.
    const lines = [
      ["exchange differences", base.fx], ["indexation (unidades de reajuste)", base.indexation],
      ["biological revaluation", base.biological], ["other income/expenses/gains", base.otherOperating],
      ["lines the split does not name", base.unexplained],
    ] as const;
    const acc = lines.reduce((a, [, x]) => a + (x ?? 0), 0);
    if (Math.abs(acc) >= 0.15 * Math.abs(pbt))
      out.push(`accounting and one-off lines ${acc > 0 ? "add" : "take"} ${pct(Math.abs(acc) / Math.abs(pbt), 0)} of profit before tax ${span}`);
    for (const [label, x] of lines)
      if (x != null && Math.abs(x) >= 0.1 * Math.abs(pbt)) out.push(`${label}: ${x > 0 ? "+" : ""}${pct(x / Math.abs(pbt), 0)} of profit before tax ${span}`);
  }
  if (pbt != null && base.tax != null && pbt > 0) {
    const etr = base.tax / pbt;
    if (base.tax < 0) out.push(`a tax credit (${mm(-base.tax)}) lifts net profit ${span}`);
    else if (etr < 0.15) out.push(`effective tax rate ${pct(etr, 0)} against Chile's 27%: check what lowers it`);
  }
  if (base.tax == null && base.beforeTax != null)
    out.push("the XBRL carries no tax line (net profit = profit before tax): read the statements' tax note before resting on the P/E or ROE");
  if (base.deferredTax != null && base.net && Math.abs(base.deferredTax) >= 0.15 * Math.abs(base.net))
    out.push(`deferred tax is ${pct(Math.abs(base.deferredTax) / Math.abs(base.net), 0)} of net profit ${span} (${base.deferredTax < 0 ? "an income that lifts it" : "an expense that lowers it"})`);
  if (ytdPrior?.netToOwners && ytdPrior.business && ytd.netToOwners != null && ytd.business != null) {
    const g = ytd.netToOwners / ytdPrior.netToOwners - 1, gb = ytd.business / ytdPrior.business - 1;
    if (ytdPrior.netToOwners > 0 && ytdPrior.business > 0) {
      if (g > 0.1 && gb < g / 2) out.push(`net profit up ${pct(g, 0)} year to date but the business ${gb >= 0 ? "only " : ""}${gb >= 0 ? "+" : ""}${pct(gb, 0)}: the growth is not the business's`);
      if (gb > 0.1 && g < 0) out.push(`the business grew ${pct(gb, 0)} year to date but net profit fell ${pct(-g, 0)}: lines outside the business took it`);
    }
  }
  if (v?.cashConversion != null && v.cashConversion < 0.8) out.push(`operating cash flow is ${n2(v.cashConversion)}× net profit: profit not backed by cash`);
  if (ttm?.netToOwners != null && ttm.netToOwners < 0) out.push("a loss over 12 months: no P/E");
  return out;
}

export interface TvRatios { pe: number | null; pb: number | null; roe: number | null }

/** The markdown block for one name. */
export function renderFinancials(
  ticker: string, cur: CmfStatements, december: CmfStatements | null, price: number, usdClp: number | null, tv: TvRatios | null
): string[] {
  const p = periodsOf(cur);
  if (!p.ytd) return [`#### ${ticker} — statements ${cur.period}: the XBRL has no year-to-date income statement.`];
  const ttmFlow = trailing(cur, december);
  const cols = [p.q, p.qPrior, p.ytd, p.ytdPrior, ttmFlow].map((f) => (f ? profitSources(f) : null));
  const [q, qp, ytd, ytdp, ttm] = cols;
  const v = valuation(cur, ttmFlow, price, usdClp);
  const mo = p.ytdMonths;
  const yr = cur.period.slice(0, 4), prev = String(Number(yr) - 1);
  const head = [mo > 3 ? `Q ${cur.period}` : null, mo > 3 ? `Q ${prev}-${cur.period.slice(5)}` : null, `${mo}M ${yr}`, `${mo}M ${prev}`, "12 months"];
  const keep = head.map((h, i) => h != null && (i < 4 || ttm));
  const row = (label: string, get: (s: ProfitSources | null, f: Flow | undefined | null) => string) =>
    `| ${label} | ${cols.map((s, i) => (keep[i] ? get(s, [p.q, p.qPrior, p.ytd, p.ytdPrior, ttmFlow][i]) : null)).filter((x) => x != null).join(" | ")} |`;
  const lines = [
    `#### ${ticker} — statements to ${cur.period} (${cur.tipo === "C" ? "consolidated" : "individual"}, ${cur.currency} millions)`,
    "",
    `| Line | ${head.filter((_, i) => keep[i]).join(" | ")} |`,
    `|---|${head.filter((_, i) => keep[i]).map(() => "---").join("|")}|`,
    row(p.ytd.GrossProfit != null ? "**Business** (gross profit − selling − admin)" : "**Business** (operating result, by nature)", (s) => mm(s?.business)),
    row("Other income / expenses / gains", (s) => mm(s?.otherOperating)),
    row("Finance, net", (s) => mm(s?.finance)),
    row("Associates", (s) => mm(s?.associates)),
    row("Exchange differences", (s) => mm(s?.fx)),
    row("Indexation (unidades de reajuste)", (s) => mm(s?.indexation)),
    row("Biological revaluation", (s) => mm(s?.biological)),
    row("Unexplained", (s) => mm(s?.unexplained)),
    row("**Profit before tax**", (s) => mm(s?.beforeTax)),
    row("Tax (of which deferred)", (s) => `${mm(s?.tax)} (${mm(s?.deferredTax)})`),
    row("Effective tax rate", (s) => (s?.tax != null && s.beforeTax ? pct(s.tax / s.beforeTax, 0) : "—")),
    row("**Net profit to owners**", (s) => mm(s?.netToOwners)),
    row("Operating cash flow", (_, f) => mm(f?.CashFlowsFromUsedInOperatingActivities)),
    row("Revenue", (_, f) => mm(f?.Revenue)),
    "",
    `Year to date against a year earlier: revenue ${chg(p.ytd.Revenue, p.ytdPrior?.Revenue)}, business ${chg(ytd?.business, ytdp?.business)}, net profit to owners ${chg(ytd?.netToOwners, ytdp?.netToOwners)}.` +
      (q && qp ? ` The quarter: business ${chg(q.business, qp.business)}, net profit ${chg(q.netToOwners, qp.netToOwners)}.` : ""),
  ];
  if (v) {
    lines.push(
      `Valuation at CLP ${n2(price)}, 12 months${cur.currency !== "CLP" ? ` (${cur.currency} at ${n2(v.fx)} CLP)` : ""}: ` +
        `EPS CLP ${n2(v.epsTtm)} · **P/E ${n2(v.pe)}** · **P/B ${n2(v.pb)}** · **ROE ${pct(v.roe)}** (on the business alone, after 27% tax: ${pct(v.roeBusiness)}) · ` +
        `cash conversion ${n2(v.cashConversion)}× · net financial debt / equity ${n2(v.netDebtToEquity)}.` +
        (tv ? ` TradingView: P/E ${n2(tv.pe)}, P/B ${n2(tv.pb)}, ROE ${pct(tv.roe)}.` : "")
    );
  }
  if (!ttm) lines.push("No 12-month figures: last December's statements are not stored.");
  const flags = qualityFlags(ttm, ytd!, ytdp, v);
  lines.push(flags.length ? `**Earnings quality:** ${flags.join("; ")}.` : "**Earnings quality:** no flag — the profit is the business's.");
  return lines;
}
