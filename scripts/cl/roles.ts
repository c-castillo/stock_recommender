/**
 * Label why each Chilean position is held (`.whatsapp/cl/roles.json`).
 *
 *   pnpm exec tsx scripts/cl/roles.ts list
 *   pnpm exec tsx scripts/cl/roles.ts set HABITAT dividend [--note "held for the dividend"]
 *   pnpm exec tsx scripts/cl/roles.ts clear HABITAT        back to a suggestion
 *
 * A label set here is the user's and binds the analysis; the analyst may
 * propose a change in the report but does not make it.
 */
import { CL_ROLES, loadClRoles, saveClRoles, type ClRole } from "@/lib/cl/roles";

const [cmd, raw, role, ...rest] = process.argv.slice(2);
const roles = loadClRoles();

if (cmd === "list" || !cmd) {
  const rows = Object.entries(roles).sort();
  if (!rows.length) console.log("No position has a label yet: every role in the bundle is a suggestion.");
  for (const [t, r] of rows) console.log(`${t.padEnd(11)} ${r.role.padEnd(9)} ${r.setOn}  ${r.note ?? ""}`);
} else if (cmd === "set" && raw && CL_ROLES.includes(role as ClRole)) {
  const i = rest.indexOf("--note");
  roles[raw.toUpperCase()] = {
    role: role as ClRole,
    note: i >= 0 ? rest[i + 1] : null,
    setOn: new Date().toISOString().slice(0, 10),
  };
  saveClRoles(roles);
  console.log(`${raw.toUpperCase()} is a ${role} holding.`);
} else if (cmd === "clear" && raw) {
  delete roles[raw.toUpperCase()];
  saveClRoles(roles);
  console.log(`${raw.toUpperCase()} is back to a suggested role.`);
} else {
  console.error(`usage: roles.ts list | set TICKER ${CL_ROLES.join("|")} [--note …] | clear TICKER`);
  process.exit(2);
}
