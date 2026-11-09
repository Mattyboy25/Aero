import type { Attachment } from "../types";
import { uid } from "./constants";

// Files the user attaches to a message. Claude can see pictures, so everything is turned into
// pictures here, in the browser: an image is resized, and a video is sampled into a few frames.
// Audio is handled separately (it becomes the video's narration).

export const MAX_ATTACHMENTS = 5;
/** Pictures per message, counting every frame of a video. The server enforces the same limit. */
export const MAX_IMAGES = 24;
export const DEFAULT_ATTACH_PROMPT = "Create an animated video based on the attached files.";
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const IMAGE_SIDE = 1568; // the size Claude reads best; larger is just resized on its end
const FRAME_SIDE = 1280;
const THUMB_SIDE = 96;

export type FileKind = "image" | "video" | "audio" | "other";

const EXT: [RegExp, FileKind][] = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i, "image"],
  [/\.(mp4|mov|m4v|webm|mkv|avi)$/i, "video"],
  [/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i, "audio"],
];

/** What a file is, from its type first and its name second. */
export function fileKind(f: File): FileKind {
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("video/")) return "video";
  if (f.type.startsWith("audio/")) return "audio";
  return EXT.find(([re]) => re.test(f.name))?.[1] ?? "other";
}

/** The `accept` list for the file picker. */
export const ACCEPT = "image/*,video/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.mov,.mkv";

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const base64Of = async (blob: Blob) => { const u = await toDataUrl(blob); return u.slice(u.indexOf(",") + 1); };
const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));

/** Draws a picture scaled down so its longest side is at most `side`. */
function scaled(src: CanvasImageSource, w: number, h: number, side: number, background?: string) {
  const k = Math.min(1, side / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d")!;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const thumbOf = (src: CanvasImageSource, w: number, h: number) => scaled(src, w, h, THUMB_SIDE, "#fff").toDataURL("image/jpeg", 0.7);

function once(el: EventTarget, ok: string, fail = "error", ms = 10000) {
  return new Promise<void>((resolve, reject) => {
    const done = (f: () => void) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener(fail, onFail); f(); };
    const onOk = () => done(resolve);
    const onFail = () => done(() => reject(new Error("unreadable")));
    const timer = setTimeout(() => done(() => reject(new Error("timeout"))), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener(fail, onFail);
  });
}

async function prepareImage(file: File): Promise<Attachment> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is too large. Use an image under 30 MB.`);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error(`This browser couldn't read ${file.name}. Try a PNG, JPEG or WebP.`); }
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024; // an SVG without a size
    // Keep transparency (logos) as PNG when it is small enough; otherwise a JPEG on white.
    const keepsAlpha = /^image\/(png|webp|gif|svg)/.test(file.type) || /\.(png|webp|gif|svg)$/i.test(file.name);
    let blob: Blob | null = null;
    if (keepsAlpha) {
      blob = await toBlob(scaled(img, w, h, IMAGE_SIDE), "image/png");
      if (blob && blob.size > 1.4 * 1024 * 1024) blob = null;
    }
    blob ??= await toBlob(scaled(img, w, h, IMAGE_SIDE, "#fff"), "image/jpeg", 0.86);
    if (!blob) throw new Error(`Couldn't prepare ${file.name}.`);
    return {
      id: uid(), kind: "image", name: file.name, thumb: thumbOf(img, w, h),
      images: [{ mediaType: blob.type, data: await base64Of(blob) }],
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareVideo(file: File): Promise<Attachment> {
  if (file.size > MAX_VIDEO_BYTES) throw new Error(`${file.name} is too large. Use a video under 600 MB.`);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    video.src = url;
    try { await once(video, "loadeddata", "error", 15000); } catch { throw new Error(`This browser couldn't read ${file.name}. Try an MP4 or WebM.`); }
    const { videoWidth: w, videoHeight: h, duration } = video;
    if (!w || !h) throw new Error(`${file.name} has no picture to look at.`);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Couldn't read how long ${file.name} is.`);

    // Frames spread evenly through the video: about one every two seconds, between 3 and 6.
    const count = Math.min(6, Math.max(3, Math.round(duration / 2)));
    const images: Attachment["images"] = [];
    let thumb = "";
    for (let i = 0; i < count; i++) {
      video.currentTime = Math.min(duration - 0.05, ((i + 0.5) / count) * duration);
      try { await once(video, "seeked", "error", 10000); } catch { throw new Error(`Couldn't read the frames of ${file.name}.`); }
      const blob = await toBlob(scaled(video, w, h, FRAME_SIDE, "#000"), "image/jpeg", 0.82);
      if (!blob) throw new Error(`Couldn't read the frames of ${file.name}.`);
      images.push({ mediaType: "image/jpeg", data: await base64Of(blob) });
      if (i === 0) thumb = thumbOf(video, w, h);
    }
    return { id: uid(), kind: "video", name: file.name, thumb, duration: Math.round(duration * 10) / 10, images };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Turns an image or video file into something Claude can look at. */
export function prepareFile(file: File): Promise<Attachment> {
  const kind = fileKind(file);
  if (kind === "image") return prepareImage(file);
  if (kind === "video") return prepareVideo(file);
  return Promise.reject(new Error(`${file.name} isn't an image, video or audio file.`));
}
