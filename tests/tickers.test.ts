/**
 * One symbol per company: what a report writes, and what the app stores.
 * Run with `pnpm test`. No network and no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanSymbol, isLocalListing, normalizeIdeas, normalizeTicker } from "../lib/market/tickers";

test("a symbol is cleaned by rule", () => {
  assert.equal(cleanSymbol(" $nvda "), "NVDA");
  assert.equal(cleanSymbol("NASDAQ:NVDA"), "NVDA");
  assert.equal(cleanSymbol("NVDA US"), "NVDA");
  assert.equal(cleanSymbol("IBM UN Equity"), "IBM");
  assert.equal(cleanSymbol("005930 KS"), "005930.KS");
  assert.equal(cleanSymbol("2330 TT"), "2330.TW");
  assert.equal(cleanSymbol("6758 JT Equity"), "6758.T");
  assert.equal(cleanSymbol("AXIA3.SA"), "AXIA3.SA");
});

test("aliases resolve to the US listing", () => {
  assert.deepEqual(normalizeTicker("KEPCO"), { ticker: "KEP", from: "KEPCO" });
  assert.equal(normalizeTicker("015760.KS").ticker, "KEP");
  assert.equal(normalizeTicker("015760 KS").ticker, "KEP");
  assert.equal(normalizeTicker("000660.KS").ticker, "SKHY"); // from lib/ma200.ts UNDERLYING
  assert.equal(normalizeTicker("2330 TT").ticker, "TSM");
  assert.equal(normalizeTicker("ROP.SW").ticker, "ROG.SW");
  assert.deepEqual(normalizeTicker("KEP"), { ticker: "KEP", from: null });
  assert.deepEqual(normalizeTicker("nvda"), { ticker: "NVDA", from: null });
  // A local code with no US listing stays as it is.
  assert.deepEqual(normalizeTicker("005930.KS"), { ticker: "005930.KS", from: null });
});

test("local listings are told from US ones", () => {
  assert.equal(isLocalListing("005930.KS"), true);
  assert.equal(isLocalListing("AXIA3.SA"), true);
  assert.equal(isLocalListing("NVDA"), false);
  assert.equal(isLocalListing("BRK.B"), false);
  assert.equal(isLocalListing(normalizeTicker("BRK/B").ticker), false);
});

test("ideas keep the report's symbol when it is replaced", () => {
  const out = normalizeIdeas([
    { ticker: "KEPCO", thesis: "Korea Electric (015760), UW, avoid" },
    { ticker: "000660.KS", thesis: "SK hynix 000660.KS: Overweight" },
    { ticker: "MU", thesis: "preferred memory" },
    { ticker: "NVDA US", thesis: "top pick" },
  ]);
  assert.equal(out[0].ticker, "KEP");
  assert.equal(out[0].thesis, "Korea Electric (015760), UW, avoid [in the report: KEPCO]");
  assert.equal(out[1].ticker, "SKHY");
  assert.equal(out[1].thesis, "SK hynix 000660.KS: Overweight"); // the code is already there
  assert.deepEqual(out[2], { ticker: "MU", thesis: "preferred memory" });
  assert.deepEqual(out[3], { ticker: "NVDA", thesis: "top pick" }); // a change of form needs no note
});
