/**
 * The macro topics: what a note or a chat line is about. Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { macroTopicsOf, normalizeMacroTopic } from "../lib/market/macro-topics";

test("a line is about every topic it names", () => {
  assert.deepEqual(macroTopicsOf("Powell habló y el CPI salió caliente"), ["Fed, rates and yields", "Inflation and data"]);
  assert.ok(macroTopicsOf("CTA selling of $28bn if SPX breaks the 200 DMA").includes("Positioning, flows and volatility"));
  assert.ok(macroTopicsOf("Democrats won the House: data center moratoria risk").includes("Politics and midterms"));
  assert.deepEqual(macroTopicsOf("gran semana arditm"), []);
});

test("a loose topic maps to ours", () => {
  assert.equal(normalizeMacroTopic("Fed, rates and yields"), "Fed, rates and yields");
  assert.equal(normalizeMacroTopic("CTA flows"), "Positioning, flows and volatility");
  assert.equal(normalizeMacroTopic("Treasury yields"), "Fed, rates and yields");
  assert.equal(normalizeMacroTopic("pineapples"), null);
});
