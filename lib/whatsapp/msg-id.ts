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
