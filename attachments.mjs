// Files the user attaches to a message. Claude can see pictures, so images go in as they are and
// a video goes in as a handful of frames sampled across it (the browser cuts them). Nothing is
// stored on the server: the pictures ride along with the one request that uses them.

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_ATTACHMENTS = 5;
const MAX_IMAGES = 24;
const MAX_IMAGE_CHARS = 8_000_000; // base64 characters, about 6 MB of picture

const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

/** Validates what the browser sent: [{ kind, name, duration?, images: [{ mediaType, data }] }]. */
export function cleanAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  let total = 0;
  const out = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    const kind = a?.kind === "video" ? "video" : "image";
    const images = (Array.isArray(a?.images) ? a.images : [])
      .filter((i) => MEDIA_TYPES.has(i?.mediaType) && typeof i?.data === "string" && i.data.length > 0 && i.data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(i.data))
      .slice(0, kind === "video" ? 8 : 1);
    if (!images.length || total + images.length > MAX_IMAGES) continue;
    total += images.length;
    out.push({
      kind,
      name: clip(a?.name, 120).replace(/[\r\n]+/g, " ").trim() || (kind === "video" ? "video" : "image"),
      duration: kind === "video" && Number(a?.duration) > 0 ? Math.round(Number(a.duration) * 10) / 10 : undefined,
      images,
    });
  }
  return out;
}

/** One line per attachment, so the model knows what each picture is. */
function label(a, n) {
  if (a.kind === "video") {
    return `Attachment ${n}: a video named "${a.name}"${a.duration ? `, ${a.duration} seconds long` : ""}. You are shown ${a.images.length} frame${a.images.length === 1 ? "" : "s"} sampled evenly from start to end, in order.`;
  }
  return `Attachment ${n}: an image named "${a.name}".`;
}

/**
 * Message content for the model: each attachment's label and pictures first, then the text.
 * With no attachments it is just the text.
 */
export function withAttachments(text, attachments) {
  if (!attachments?.length) return text;
  const blocks = [];
  attachments.forEach((a, i) => {
    blocks.push({ type: "text", text: label(a, i + 1) });
    for (const img of a.images) blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  });
  blocks.push({ type: "text", text });
  return blocks;
}
