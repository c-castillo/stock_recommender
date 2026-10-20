/**
 * The main analyst's ADDs on Chilean names, kept apart from the US ledger
 * table so a "+COPEC" never becomes a US position and a US ADD never reaches
 * this book. Same lifecycle as the US ledger (playbook: ADD LIFECYCLE):
 * ACTIVE, AGING after 90 days, EXPIRED when aging under a falling MA200,
 * INVALIDATED below the level the main analyst stated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CL_LEDGER } from "./config";

export interface ClAdd {
  ticker: string;
  /** Price at the ADD, CLP, as he wrote it. */
  entryPrice: string | null;
  addedOn: string;
  note: string | null;
  invalidation: number | null;
  active: boolean;
}

export type ClAddStatus = "ACTIVE" | "AGING" | "EXPIRED" | "INVALIDATED";

const AGING_DAYS = 90;

export function loadClLedger(): ClAdd[] {
  if (!existsSync(CL_LEDGER)) return [];
  return JSON.parse(readFileSync(CL_LEDGER, "utf8")).adds ?? [];
}

export function saveClLedger(adds: ClAdd[]): void {
  mkdirSync(dirname(CL_LEDGER), { recursive: true });
  writeFileSync(CL_LEDGER, JSON.stringify({ adds }, null, 1));
}

/** A missing price or slope never demotes an ADD. */
export function clAddStatus(a: ClAdd, price: number | null, slope: number | null, today = new Date()): {
  status: ClAddStatus;
  ageDays: number;
} {
  const ageDays = Math.floor((today.getTime() - Date.parse(a.addedOn + "T00:00:00Z")) / 86_400_000);
  const aging = ageDays > AGING_DAYS;
  const status: ClAddStatus =
    a.invalidation != null && price != null && price < a.invalidation
      ? "INVALIDATED"
      : aging && slope != null && slope < 0
        ? "EXPIRED"
        : aging
          ? "AGING"
          : "ACTIVE";
  return { status, ageDays };
}
