import type { AudioClip, SpokenLine, Upload } from "../types";
import { KEY_HEADERS } from "./keys";
import { uid } from "./constants";

// Narration the user uploads for a new video: transcribed with ElevenLabs, split into spoken
// lines, and turned into narration clips (one per line, all playing slices of the one recording).

export const MAX_UPLOAD_SECONDS = 60;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
export const DEFAULT_UPLOAD_PROMPT = "Create an animated video for this narration.";

export interface Word { text: string; start: number; end: number }

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm|mp4)$/i;
export const looksLikeAudio = (f: File) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);

/** Sends the recording to the server, which has ElevenLabs transcribe it. */
export async function transcribe(file: Blob, key: string, signal: AbortSignal): Promise<{ words: Word[]; language: string | null }> {
  const res = await fetch("/api/audio/transcribe", {
    method: "POST", signal, body: file,
    headers: { "Content-Type": file.type || "audio/mpeg", [KEY_HEADERS.elevenlabs]: key },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
  const data = await res.json();
  return { words: data.words as Word[], language: data.language ?? null };
}

const joinWords = (ws: Word[]) => ws.map((w) => w.text).join(" ");

/** Groups words into caption-sized lines: at sentence ends, long pauses, and when a line gets long. */
export function linesFromWords(words: Word[]): SpokenLine[] {
  const lines: SpokenLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = Math.max(start + 0.2, cur[cur.length - 1].end);
    lines.push({ start, end, text: joinWords(cur) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.8) flush();
    cur.push(w);
    const len = joinWords(cur).length;
    const sentenceEnd = /[.!?…。！？]["'”’)\]]?$/.test(w.text);
    if ((sentenceEnd && cur.length >= 3) || cur.length >= 14 || len >= 72 || (/[,;:]$/.test(w.text) && len >= 46)) flush();
  }
  flush();
  return lines;
}

/**
 * One narration clip per spoken line, each a slice of the uploaded recording. The slices follow
 * the speech with a little room around it and never overlap, and the pauses between lines are left out.
 */
export function clipsFromUpload(u: Upload): AudioClip[] {
  const clips: AudioClip[] = [];
  let cursor = 0;
  u.lines.forEach((line, i) => {
    const nextStart = u.lines[i + 1]?.start ?? Infinity;
    const from = Math.min(Math.max(cursor, line.start - 0.12), line.start);
    const to = Math.min(u.duration, Math.max(line.end, Math.min(line.end + 0.3, nextStart - 0.12)));
    if (to - from < 0.1) return;
    cursor = to;
    clips.push({
      id: uid(), kind: "narration", start: from, duration: to - from, offset: from,
      text: line.text, volume: u.voiceover ? 1 : 0, sourceId: u.sourceId, source: "upload",
    });
  });
  return clips;
}
