/**
 * Why each Chilean position is held: for its DIVIDEND, for GROWTH, or as a
 * BET. Some names (HABITAT, AGUAS-A) are in the book for the cash they pay,
 * and a trend rule written for growth stocks would sell them for the wrong
 * reason. The role decides which rules judge a position (playbook: POSITION
 * ROLES).
 *
 * The user's label is binding. A position the user has not labelled gets a
 * suggestion from its numbers, shown as "suggested" until confirmed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CL_DIR } from "./config";

export type ClRole = "dividend" | "growth" | "bet";
export const CL_ROLES: ClRole[] = ["dividend", "growth", "bet"];
export const CL_ROLES_FILE = join(CL_DIR, "roles.json");

export interface ClRoleEntry {
  role: ClRole;
  note: string | null;
  setOn: string;
}

export function loadClRoles(): Record<string, ClRoleEntry> {
  if (!existsSync(CL_ROLES_FILE)) return {};
  return JSON.parse(readFileSync(CL_ROLES_FILE, "utf8"));
}

export function saveClRoles(roles: Record<string, ClRoleEntry>): void {
  mkdirSync(dirname(CL_ROLES_FILE), { recursive: true });
  writeFileSync(CL_ROLES_FILE, JSON.stringify(roles, null, 1));
}

/** Points of yield over the cash fund that make a name an income holding. */
export const DIVIDEND_MARGIN = 0.01;

/**
 * A first guess from the numbers, for a position the user has not labelled:
 * a yield at least a point over the money-market fund is a dividend holding;
 * a lower-yielding name above its 200-day average is growth; the rest is a
 * bet. `yieldPc` and `cashApr` are fractions; null data gives no dividend.
 */
export function suggestRole(yieldPc: number | null, aboveSma200: boolean | null, cashApr: number): ClRole {
  if (yieldPc != null && yieldPc >= cashApr + DIVIDEND_MARGIN) return "dividend";
  if (aboveSma200) return "growth";
  return "bet";
}
