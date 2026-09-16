/**
 * Seed the performance anchor from Zesty broker data.
 *
 * Year-start value and the weekly series come from get_portfolio_history (1A,
 * last equity of each ISO week); flows from get_movements (amountInUsd, deposits positive, withdrawals
 * negative); peak from the same history series. Re-run with fresh numbers when
 * new deposits land — everything else is computed live.
 */
import { setPerformanceAnchor } from "@/lib/whatsapp/db";

setPerformanceAnchor({
  asOf: "2026-09-15",
  yearStartDate: "2025-12-31",
  yearStartValue: 23319.9,
  flows: [
    { date: "2026-01-05", amount: -446.67 },
    { date: "2026-01-06", amount: -451.55 },
    { date: "2026-01-22", amount: 571.17 },
    { date: "2026-01-29", amount: 576.2 },
    { date: "2026-06-12", amount: 1100.35 },
    { date: "2026-06-18", amount: 1099.26 },
    { date: "2026-07-02", amount: 1068.26 },
    { date: "2026-07-06", amount: 1068.23 },
    { date: "2026-07-07", amount: 1066.89 },
    { date: "2026-07-17", amount: 1061.51 },
    { date: "2026-07-28", amount: 1056.06 },
  ],
  series: [
    { date: "2025-09-19", value: 40266.38 }, { date: "2025-09-26", value: 38422.97 },
    { date: "2025-10-03", value: 42564.89 }, { date: "2025-10-10", value: 36714.83 },
    { date: "2025-10-17", value: 31563.98 }, { date: "2025-10-24", value: 35117.13 },
    { date: "2025-10-31", value: 33846.16 }, { date: "2025-11-07", value: 25863.59 },
    { date: "2025-11-14", value: 21783.52 }, { date: "2025-11-21", value: 18333.17 },
    { date: "2025-11-27", value: 28922.51 }, { date: "2025-12-05", value: 27212.65 },
    { date: "2025-12-12", value: 27096.2 }, { date: "2025-12-19", value: 25681.89 },
    { date: "2025-12-26", value: 24303.36 }, { date: "2026-01-02", value: 25194.89 },
    { date: "2026-01-09", value: 24276.78 }, { date: "2026-01-16", value: 26421.86 },
    { date: "2026-01-23", value: 23749.99 }, { date: "2026-01-30", value: 22607.42 },
    { date: "2026-02-06", value: 22770.85 }, { date: "2026-02-13", value: 22677.66 },
    { date: "2026-02-20", value: 22631.23 }, { date: "2026-02-27", value: 22383.33 },
    { date: "2026-03-06", value: 20814.86 }, { date: "2026-03-13", value: 20991.85 },
    { date: "2026-03-20", value: 20814.02 }, { date: "2026-03-27", value: 21935.09 },
    { date: "2026-04-02", value: 23305.02 }, { date: "2026-04-10", value: 25352.16 },
    { date: "2026-04-17", value: 25720.06 }, { date: "2026-04-24", value: 26585.42 },
    { date: "2026-05-01", value: 26439.72 }, { date: "2026-05-08", value: 27852.56 },
    { date: "2026-05-15", value: 28031.87 }, { date: "2026-05-22", value: 28108.79 },
    { date: "2026-05-29", value: 28313.54 }, { date: "2026-06-05", value: 27742.93 },
    { date: "2026-06-12", value: 29082.01 }, { date: "2026-06-18", value: 31593.1 },
    { date: "2026-06-26", value: 30537.74 }, { date: "2026-07-02", value: 29842.79 },
    { date: "2026-07-10", value: 33497.63 }, { date: "2026-07-17", value: 28309.05 },
    { date: "2026-07-24", value: 29350.62 }, { date: "2026-07-31", value: 28055.16 },
    { date: "2026-08-07", value: 30015.52 }, { date: "2026-08-14", value: 35378.35 },
    { date: "2026-08-21", value: 33885.09 }, { date: "2026-08-28", value: 33000.14 },
    { date: "2026-09-04", value: 33989.45 }, { date: "2026-09-11", value: 34248.51 },
    { date: "2026-09-14", value: 31839.11 },
  ],
  peak: { date: "2026-08-17", value: 37302.82 },
  source: "Zesty get_portfolio_history + get_movements",
});
console.log("performance anchor stored");
