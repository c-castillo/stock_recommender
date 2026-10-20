/**
 * The Itaú statement parser: the Chilean book has no broker connector, so a
 * misread column here would size every order wrong. The fixture keeps the
 * statement's layout with made-up holdings and no client data.
 * Run with `pnpm test`. No network and no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkStatement, clNumber, parseStatement } from "../lib/cl/holdings";
import { fromYahoo, yahooSymbol } from "../lib/cl/config";
import { suggestRole } from "../lib/cl/roles";

const FIXTURE = `
                                                                                           Desde:                           01/10/2026
                                                                                           Hasta:                           19/10/2026
                Caja                                                                          0
                Operaciones por Liquidar                                                  80.000 EUR                                             Cargos          Abonos
Pesos (CLP)                                               10.240.000
Valor USD       $     981,65
Dividendos                       144.240                     162.855
  Mercado: Acciones CLP
AGUAS-A                                        Activo:               20.000                       0                    0                        0          347,5800          333,0000             6.660.000               143.907            -2,12%
Rubro: Servicios Publicos                      Pasivo:                    0                       0                    0                        0                            333,0000                     0                     0
AGUAS ANDINAS S.A.
PROVIDA                       Activo:         800                                                 0                    0                        0        5.063,7600         4.936,5000            3.949.200               145.600           + 1,08%
                              Pasivo:
Rubro: Inversiones e Inmobiliarias              0                                                 0                    0                        0                           4.936,5000                    0                     0
ADMINISTRADORA DE FONDOS DE PENSIONES PROVIDA S.A.
Detalle Cartera Fondos Mutuos
CFMITASEM1                                                                                0,1000                  0,0000                               2.000,0000                2.000,0000                   200,00           0,00%
FM ITAU SELECT F1
Total :           1 Instrumentos                                                                                                                      Valor Total de la Cartera (CLP):                    200,00             0,00%
01/10/2026 36690422   FM     Retiro Fondo Mutuo               CFMITASEM1            ITAU                                                      0,000000             1.814,646900         2.389,055100                               4.335.291
19/10/2026 37095143   FM     Aporte Fondos Mutuos             CFMITASEM1            ITAU                                                      0,000000             1.814,647000         2.393,176700                               4.342.771
`;

test("cl: Chilean number format", () => {
  assert.equal(clNumber("1.234.567,89"), 1234567.89);
  assert.equal(clNumber("+ 22,01%"), 22.01);
  assert.equal(clNumber("-2,12%"), -2.12);
  assert.equal(clNumber("20.000"), 20000);
});

test("cl: statement positions, fund, cash and the fund's yield", () => {
  const s = parseStatement(FIXTURE);
  assert.equal(s.asOf, "2026-10-19");
  assert.equal(s.from, "2026-10-01");
  assert.deepEqual(
    s.positions.map((p) => [p.ticker, p.shares, p.avgCost, p.statementPrice, p.marketValue, p.rubro]),
    [
      ["AGUAS-A", 20000, 347.58, 333, 6660000, "Servicios Publicos"],
      // The wrapped layout: Pasivo on its own line, Rubro after it.
      ["PROVIDA", 800, 5063.76, 4936.5, 3949200, "Inversiones e Inmobiliarias"],
    ]
  );
  assert.equal(s.positions[1].company, "ADMINISTRADORA DE FONDOS DE PENSIONES PROVIDA S.A.");
  assert.ok(Math.abs(s.positions[1].returnPc - 0.0108) < 1e-9);
  assert.deepEqual(s.funds.map((f) => [f.code, f.name, f.value]), [["CFMITASEM1", "FM ITAU SELECT F1", 200]]);
  assert.equal(s.cash, 0);
  assert.equal(s.pendingSettlement, 80000);
  assert.equal(s.totalValue, 10240000);
  assert.equal(s.usdClp, 981.65);
  assert.deepEqual(s.projectedDividends, { next30: 144240, next31to90: 162855 });
  // 2389.0551 → 2393.1767 over 18 days ≈ 3.56% a year.
  assert.ok(s.fundYield != null && Math.abs(s.fundYield - 0.0356) < 0.0005);
});

test("cl: a statement that does not add up is flagged", () => {
  const s = parseStatement(FIXTURE);
  assert.deepEqual(checkStatement({ ...s, totalValue: 10_689_400 }), []);
  assert.equal(checkStatement(s).length, 1);
  const bad = { ...s, totalValue: 0, positions: [{ ...s.positions[0], marketValue: 1 }] };
  assert.match(checkStatement(bad)[0], /AGUAS-A/);
});

test("cl: Yahoo symbols", () => {
  assert.equal(yahooSymbol("ANDINA-B"), "ANDINA-B.SN");
  assert.equal(yahooSymbol("CLP=X"), "CLP=X");
  assert.equal(yahooSymbol("CFMITNIPSA.SN"), "CFMITNIPSA.SN");
  assert.equal(fromYahoo("SQM-B.SN"), "SQM-B");
});

test("cl: a suggested role follows yield first, then trend", () => {
  // HABITAT: 7.1% against a 3.56% fund clears the one-point margin.
  assert.equal(suggestRole(0.0714, false, 0.0356), "dividend");
  // ANDINA-B: 3.6% does not; above its SMA200, so growth.
  assert.equal(suggestRole(0.0356, true, 0.0356), "growth");
  // CENCOSUD: low yield, under its SMA200.
  assert.equal(suggestRole(0.0134, false, 0.0356), "bet");
  assert.equal(suggestRole(null, null, 0.0356), "bet");
});
