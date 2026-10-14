/**
 * What it costs to act and what it pays to wait, at this broker.
 *
 * Both numbers change the arithmetic of every recommendation: a trade has to
 * earn back its commissions before it has earned anything, and money left in
 * cash is not idle, it is paid. They live here so the portfolio block, the
 * performance table and the playbook's rules quote the same figures.
 */

/** Commission per side, as a fraction of the order's value (Zesty: 0.30%). */
export const COMMISSION_PC = 0.003;

/** Yearly interest the broker pays on uninvested cash (about 3.5% APR). */
export const CASH_APR = 0.035;

/** Buying and later selling the same amount. Also the cost of a swap: one
 *  sale and one purchase of the amount moved. */
export const ROUND_TRIP_PC = 2 * COMMISSION_PC;

/** What cash earns over a number of calendar days, as a fraction. */
export function cashReturn(days: number): number {
  return Math.pow(1 + CASH_APR, Math.max(days, 0) / 365) - 1;
}

/** Weeks a position must be held before its round trip costs less than the
 *  interest the same money would have earned. */
export const BREAK_EVEN_WEEKS = (ROUND_TRIP_PC / CASH_APR) * 52;

/** The most one position may lose between its entry and its stop, as a
 *  fraction of the book. Sizes a BUY together with the weight rule: whichever
 *  gives fewer shares wins. */
export const RISK_PER_POSITION = 0.0075;

/** Shares the risk budget allows for an entry and a stop under it. */
export function sharesAtRisk(book: number, entry: number, stop: number): number {
  const perShare = entry - stop;
  return perShare > 0 ? Math.floor((book * RISK_PER_POSITION) / perShare) : 0;
}
