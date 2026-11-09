import type { AudioClip, ModelKey, VersionAudio } from "../types";
import { KEY_HEADERS } from "./keys";
import { putClip } from "./audioStore";
import { uid } from "./constants";

export interface AudioRequest {
  code: string;
  prompt: string;
  title: string;
  duration: number;
  scenes: { start: number; end: number; title: string }[];
  previous?: string;
  narration: boolean;
  sfx: boolean;
  voiceId: string;
  model: ModelKey;
  keys: { anthropic: string; elevenlabs: string };
  decode: (blob: Blob) => Promise<AudioBuffer>;
  onDecoded?: (id: string, buffer: AudioBuffer) => void;
  onProgress: (stage: "planning" | "generating", done: number, total: number) => void;
  signal: AbortSignal;
}

interface Plan {
  narration: { start: number; text: string }[];
  sfx: { start: number; duration: number; prompt: string; volume: number }[];
}

const CONCURRENCY = 3;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

async function errorOf(res: Response) {
  const body = await res.json().catch(() => ({}));
  return body.error || `Server error ${res.status}`;
}

// POSTs to an audio route and returns the sound, retrying when ElevenLabs is busy.
async function fetchAudio(path: string, body: object, key: string, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`/api/audio/${path}`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", [KEY_HEADERS.elevenlabs]: key },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.blob();
    if ((res.status === 429 || res.status === 502) && attempt < 3) { await sleep(1500 * (attempt + 1), signal); continue; }
    throw new Error(await errorOf(res));
  }
}

/** Plans the audio with Claude, then voices each line and makes each sound with ElevenLabs. */
export async function generateAudio(r: AudioRequest): Promise<VersionAudio> {
  r.onProgress("planning", 0, 0);
  const planRes = await fetch("/api/audio/plan", {
    method: "POST", signal: r.signal,
    headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: r.keys.anthropic },
    body: JSON.stringify({
      code: r.code, prompt: r.prompt, title: r.title, duration: r.duration, scenes: r.scenes,
      previous: r.previous, narration: r.narration, sfx: r.sfx, model: r.model,
    }),
  });
  if (!planRes.ok) throw new Error(await errorOf(planRes));
  const plan: Plan = await planRes.json();

  type Task = () => Promise<AudioClip>;
  const tasks: Task[] = [];
  const lines = plan.narration;
  lines.forEach((line, i) => tasks.push(async () => {
    // Each line has until the next one starts (or the video ends) to finish.
    const slot = Math.max(0.6, (lines[i + 1]?.start ?? r.duration) - line.start - 0.1);
    const ctx = { previousText: lines[i - 1]?.text, nextText: lines[i + 1]?.text };
    let blob = await fetchAudio("tts", { text: line.text, voiceId: r.voiceId, ...ctx }, r.keys.elevenlabs, r.signal);
    let buf = await r.decode(blob);
    // Too long for its slot: read it once more, a little faster.
    if (buf.duration > slot * 1.05) {
      const speed = Math.min(1.2, buf.duration / slot);
      blob = await fetchAudio("tts", { text: line.text, voiceId: r.voiceId, speed, ...ctx }, r.keys.elevenlabs, r.signal);
      buf = await r.decode(blob);
    }
    return save("narration", line.start, line.text, 1, blob, buf);
  }));
  for (const cue of plan.sfx) tasks.push(async () => {
    const blob = await fetchAudio("sfx", { prompt: cue.prompt, duration: cue.duration }, r.keys.elevenlabs, r.signal);
    return save("sfx", cue.start, cue.prompt, cue.volume, blob, await r.decode(blob));
  });
  if (!tasks.length) throw new Error("Claude didn't plan any audio for this video. Try again.");

  async function save(kind: AudioClip["kind"], start: number, text: string, volume: number, blob: Blob, buf: AudioBuffer): Promise<AudioClip> {
    const id = uid();
    await putClip(id, blob);
    r.onDecoded?.(id, buf);
    return { id, kind, start, duration: buf.duration, text, volume };
  }

  // Run a few at a time. A failed clip is skipped unless every clip fails.
  let done = 0;
  let firstError: unknown = null;
  const clips: AudioClip[] = [];
  r.onProgress("generating", 0, tasks.length);
  const queue = [...tasks];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try { clips.push(await task()); } catch (err: any) {
        if (err?.name === "AbortError") throw err;
        firstError ??= err;
      }
      r.onProgress("generating", ++done, tasks.length);
    }
  }));
  if (!clips.length) throw firstError instanceof Error ? firstError : new Error("No audio could be generated.");
  clips.sort((a, b) => a.start - b.start);
  return { clips, voiceId: r.narration ? r.voiceId : undefined, createdAt: Date.now(), skipped: tasks.length - clips.length || undefined };
}

/** Voices a single line again, for example after its caption was edited. */
export function voiceLine(opts: { text: string; voiceId: string; key: string; previousText?: string; nextText?: string; signal?: AbortSignal }) {
  const { text, voiceId, key, previousText, nextText } = opts;
  return fetchAudio("tts", { text, voiceId, previousText, nextText }, key, opts.signal ?? new AbortController().signal);
}
