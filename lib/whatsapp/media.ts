import { type Message } from "whatsapp-web.js";
import path from "path";
import fs from "fs";

const MEDIA_DIR = path.join(process.cwd(), ".whatsapp", "media");

export interface MediaResult {
  media_type: string;
  media_mime: string;
  media_filename: string;
  media_path: string;
}

const TYPE_MAP: Record<string, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  ptt: "audio",
  document: "document",
  sticker: "sticker",
};

/**
 * Download a media message and save it to disk.
 * Returns null if the message has no media or download fails.
 */
export async function downloadAndSave(msg: Message): Promise<MediaResult | null> {
  if (!msg.hasMedia) return null;

  const media = await msg.downloadMedia();
  if (!media?.data) return null;

  const media_type = TYPE_MAP[msg.type] ?? msg.type;
  const media_mime = media.mimetype ?? "application/octet-stream";

  const ext = media_mime.split("/")[1]?.split(";")[0] ?? "bin";

  // Skip unwanted file types
  const SKIP_EXTENSIONS = new Set(["webp", "mp4"]);
  if (SKIP_EXTENSIONS.has(ext.toLowerCase())) return null;

  const originalName = media.filename;
  const safeName = originalName
    ? originalName.replace(/[^a-z0-9._-]/gi, "_")
    : `${msg.id._serialized}.${ext}`;

  const jidSafe = msg.from.replace(/[^a-z0-9@._-]/gi, "_");
  const dir = path.join(MEDIA_DIR, jidSafe);
  fs.mkdirSync(dir, { recursive: true });

  const media_filename = safeName;
  const media_path = path.join(dir, safeName);

  if (!fs.existsSync(media_path)) {
    fs.writeFileSync(media_path, Buffer.from(media.data, "base64"));
  }

  return { media_type, media_mime, media_filename, media_path };
}
