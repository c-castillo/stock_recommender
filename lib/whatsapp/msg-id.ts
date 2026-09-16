import { createHash } from "crypto";
import type { Message } from "whatsapp-web.js";

// Raw shape of a whatsapp-web.js message id after serialize(). Any WhatsApp
// release can rename these, so every field is optional and we stay defensive.
interface SerializableId {
  _serialized?: string;
  fromMe?: boolean;
  remote?: string | { _serialized?: string };
  id?: string;
  participant?: string | { _serialized?: string };
}

/**
 * Reconstruct and backfill a message's `_serialized` id.
 *
 * Since ~2026-07-15 the WhatsApp Web build stopped exposing `_serialized` on the
 * MsgKey (the getter was minified/renamed — it shows up as `$1`), so
 * whatsapp-web.js 1.34.7 reads `msg.id._serialized` as `undefined`. That single
 * break both stored NULL message ids AND killed every media download, because
 * `Message.downloadMedia()` looks the live message up by that serialized id
 * (`Msg.get(this.id._serialized)`).
 *
 * We rebuild the id from its parts — the format
 * `${fromMe}_${remote}_${id}[_${participant}]` is proven to resolve the live
 * message via `Msg.get()` — and patch it back onto the object so the library's
 * own `downloadMedia()`/`delete()`/etc. work unchanged.
 *
 * Returns the serialized id, or null if the parts are missing.
 */
export function ensureSerializedId(msg: Message | null | undefined): string | null {
  const id = (msg as unknown as { id?: SerializableId } | null | undefined)?.id;
  if (!id) return null;
  if (id._serialized) return id._serialized;

  const fromMe = id.fromMe ? "true" : "false";
  const remote = typeof id.remote === "object" ? id.remote?._serialized : id.remote;
  const idHex = id.id;
  const participant =
    typeof id.participant === "object" ? id.participant?._serialized : id.participant;

  if (!remote || !idHex) return null;

  const serialized = `${fromMe}_${remote}_${idHex}${participant ? `_${participant}` : ""}`;
  id._serialized = serialized; // patch so library internals that read it work
  return serialized;
}

/**
 * A deterministic stand-in id for a message whose WhatsApp id could not be
 * rebuilt at all.
 *
 * `id` is the PRIMARY KEY, but SQLite permits NULL in a non-INTEGER primary
 * key — so during the July 2026 breakage 415 rows landed with `id IS NULL`.
 * Such a row is invisible to every `WHERE id = ?`: it cannot be updated
 * (relevance marking silently no-ops), cannot be deleted by id, and never
 * dedupes on resync because ON CONFLICT(id) does not fire for NULL, so each
 * resync appends another copy.
 *
 * Derived from the message's own content so the same message always yields the
 * same id and ON CONFLICT can do its job.
 */
export function surrogateMessageId(parts: {
  jid: string;
  ts: number;
  sender?: string | null;
  body?: string | null;
}): string {
  const digest = createHash("sha1")
    .update(`${parts.jid}\n${parts.ts}\n${parts.sender ?? ""}\n${parts.body ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `recovered_${parts.jid}_${parts.ts}_${digest}`;
}
