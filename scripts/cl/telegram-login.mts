/**
 * Log the Telegram sync in as the user's account, once, in two
 * non-interactive steps (so it runs from a `!` prompt):
 *
 *   pnpm exec tsx scripts/cl/telegram-login.mts send-code +56912345678
 *   pnpm exec tsx scripts/cl/telegram-login.mts code 12345 [2FA password]
 *
 * The first asks Telegram for a login code (it arrives in the Telegram app)
 * and keeps the half-open session; the second signs in with it and saves the
 * session to `.whatsapp/cl/telegram.session`. To log out, terminate the
 * session in Telegram → Settings → Devices and delete that file.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "telegram";
import { CL_DIR } from "@/lib/cl/config";
import { credentials, makeClient, saveSession, SESSION_FILE } from "@/lib/cl/telegram-client";

const PENDING = join(CL_DIR, "telegram.login.json");
const PENDING_SESSION = join(CL_DIR, "telegram.login.session");
const [cmd, arg, password] = process.argv.slice(2);

if (cmd === "send-code" && arg) {
  const client = makeClient("");
  await client.connect();
  const { phoneCodeHash, isCodeViaApp } = await client.sendCode(credentials(), arg);
  saveSession(client, PENDING_SESSION);
  writeFileSync(PENDING, JSON.stringify({ phone: arg, phoneCodeHash }), { mode: 0o600 });
  await client.disconnect();
  console.log(`Code sent ${isCodeViaApp ? "to the Telegram app" : "by SMS"}. Now: pnpm exec tsx scripts/cl/telegram-login.mts code <code> [2FA password]`);
} else if (cmd === "code" && arg) {
  if (!existsSync(PENDING)) throw new Error("No pending login: run send-code first.");
  const { phone, phoneCodeHash } = JSON.parse(readFileSync(PENDING, "utf8"));
  const client = makeClient(readFileSync(PENDING_SESSION, "utf8").trim());
  await client.connect();
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: arg }));
  } catch (e) {
    if (!String((e as Error).message).includes("SESSION_PASSWORD_NEEDED")) throw e;
    if (!password) throw new Error("The account has a 2FA password: run `code <code> <password>`.");
    await client.signInWithPassword(credentials(), { password: async () => password, onError: async (err) => { throw err; } });
  }
  saveSession(client);
  rmSync(PENDING);
  rmSync(PENDING_SESSION);
  const me = (await client.getMe()) as Api.User;
  await client.disconnect();
  console.log(`Logged in as ${[me.firstName, me.lastName].filter(Boolean).join(" ")}; session saved to ${SESSION_FILE}.`);
} else {
  console.error("usage: telegram-login.mts send-code <+phone> | code <code> [2FA password]");
  process.exit(2);
}
