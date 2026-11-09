// Narration and sound effects. Claude reads the animation code and plans a timed script and
// sound cues; ElevenLabs turns each line and cue into audio. The browser drives the steps, so
// each route here does one job: plan, speak one line, make one sound, or list voices.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { pickModel, streamMessage } from "./models.mjs";

const ANTHROPIC_KEY_HEADER = "x-anthropic-key";
const ELEVENLABS_KEY_HEADER = "x-elevenlabs-key";
const ELEVEN = "https://api.elevenlabs.io";
const TTS_MODEL = "eleven_multilingual_v2";
const SFX_MODEL = "eleven_text_to_sound_v2";
export const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // "George", a premade narrator voice

const cleanKey = (v) => (typeof v === "string" && v.trim().length >= 8 && v.length <= 400 ? v.trim() : "");
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const router = express.Router();

// ---------- planning ----------

const PLAN_PROMPT = `You are a sound designer and voiceover writer for short motion-graphics videos. Each video is a deterministic Canvas 2D animation written in JavaScript: \`draw(ctx, t)\` paints the frame at time \`t\` seconds, and motion is usually choreographed with anime.js timelines (\`.add(target, { ... duration }, startMs)\` — the third argument is the start time in milliseconds), \`progress(t, start, end)\` windows, or explicit comparisons against \`t\`.

Read the code carefully and work out when each visual beat happens: entrances, text reveals, impacts, transitions between scenes, counters, and the ending. Then plan audio that lands exactly on those beats.

## Narration (only when asked for)
- A short voiceover script split into lines. Each line has a \`start\` time in seconds and the \`text\` to speak.
- Speech runs at about 2.5 words per second. Each line must finish before the next line starts and before the video ends, with a small breath of space. Never cram: fewer, well-placed words beat a rushed read.
- Start the first line a beat after the video begins (around 0.3–0.8 s). Time lines to land with what appears on screen, and don't read on-screen text word for word unless it is a title.
- Match the tone of the piece: confident and warm by default; playful, dramatic or calm when the visuals call for it. No stage directions, emoji, or markup in the text.

## Sound effects (only when asked for)
- Cues tied to specific visual events. Each has a \`start\` time in seconds, a \`duration\` (0.5–10 s; most hits are 0.5–2 s), a \`prompt\` describing the sound, and a \`volume\` from 0.1 to 1.
- Prompts are for a text-to-sound model: be concrete about the sound itself, for example "soft airy whoosh, quick, clean, modern UI", "deep cinematic impact with a short sub boom", "glassy digital shimmer rising", "single crisp mouse click". Never ask for speech or music with lyrics.
- Usually 3–10 cues. Time each to the exact moment of its event (a whoosh starts slightly before the motion peaks; an impact lands on the frame of contact).
- You may add one quiet ambient bed or atmosphere that runs under the whole video (start 0, duration up to the video length, max 30 s, volume 0.15–0.35), when the piece benefits from it.
- Keep effects under narration: lower their volume where a line is being spoken.

All times must lie within the video. Return empty arrays for anything you weren't asked to make.`;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["narration", "sfx"],
  properties: {
    narration: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "text"],
        properties: { start: { type: "number" }, text: { type: "string" } },
      },
    },
    sfx: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "duration", "prompt", "volume"],
        properties: {
          start: { type: "number" },
          duration: { type: "number" },
          prompt: { type: "string" },
          volume: { type: "number" },
        },
      },
    },
  },
};

router.post("/plan", async (req, res) => {
  const apiKey = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
  if (!apiKey) return res.status(401).json({ error: "Add your Anthropic API key in Settings > API." });
  const { code, prompt, title, duration, narration, sfx, model, scenes, previous } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "There's no animation code to plan audio for." });
  if (!narration && !sfx) return res.status(400).json({ error: "Turn on narration or sound effects in Settings first." });
  const dur = clamp(Number(duration) || 8, 1, 300);

  const parts = [
    `Video length: ${dur} seconds.`,
    `Make: ${[narration && "narration", sfx && "sound effects"].filter(Boolean).join(" and ")}.`,
  ];
  if (title) parts.push(`Title: ${String(title).slice(0, 200)}`);
  if (prompt) parts.push(`<request>\n${String(prompt).slice(0, 4000)}\n</request>`);
  if (Array.isArray(scenes) && scenes.length) {
    parts.push(`<scenes>\n${scenes.slice(0, 24).map((s) => `${Number(s.start).toFixed(2)}–${Number(s.end).toFixed(2)}s: ${String(s.title).slice(0, 120)}`).join("\n")}\n</scenes>`);
  }
  if (typeof previous === "string" && previous.trim()) {
    parts.push(`<previous_narration>\nThe earlier version of this video had this script. Keep its voice and reuse lines that still fit the new timing.\n${previous.slice(0, 3000)}\n</previous_narration>`);
  }
  parts.push(`<code>\n${code.slice(0, 120000)}\n</code>`);

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const client = new Anthropic({ apiKey });
    const stream = streamMessage(client, pickModel(model), {
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } },
      system: [{ type: "text", text: PLAN_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: parts.join("\n\n") }],
    }, { signal: controller.signal });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") return res.status(422).json({ error: "Claude declined to write audio for this video." });
    const lastFallback = message.content.findLastIndex((b) => b.type === "fallback");
    const text = message.content.slice(lastFallback + 1).filter((b) => b.type === "text").map((b) => b.text).join("");
    let plan;
    try { plan = JSON.parse(text); } catch { return res.status(502).json({ error: "The audio plan couldn't be read. Try again." }); }

    // Keep everything inside the video and within ElevenLabs' limits.
    const lines = (narration ? plan.narration : [])
      .filter((l) => typeof l.text === "string" && l.text.trim())
      .map((l) => ({ start: clamp(Number(l.start) || 0, 0, dur - 0.3), text: l.text.trim().slice(0, 600) }))
      .sort((a, b) => a.start - b.start)
      .slice(0, Math.max(24, Math.ceil(dur / 3)));
    const cues = (sfx ? plan.sfx : [])
      .filter((c) => typeof c.prompt === "string" && c.prompt.trim())
      .map((c) => {
        const start = clamp(Number(c.start) || 0, 0, dur - 0.1);
        return {
          start,
          duration: clamp(Math.min(Number(c.duration) || 1, dur - start + 0.5), 0.5, 30),
          prompt: c.prompt.trim().slice(0, 450),
          volume: clamp(Number(c.volume) || 0.7, 0.05, 1),
        };
      })
      .sort((a, b) => a.start - b.start)
      .slice(0, Math.max(20, Math.ceil(dur / 6)));
    res.json({ narration: lines, sfx: cues });
  } catch (err) {
    res.status(err?.status && err.status < 600 ? err.status : 500).json({ error: describeAnthropic(err) });
  }
});

function describeAnthropic(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected your API key. Check it in Settings > API.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Wait a moment and try again.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}

// ---------- ElevenLabs ----------

// Streams an ElevenLabs audio reply back, or turns its error into a short message.
async function relay(res, url, key, body) {
  const key11 = cleanKey(key);
  if (!key11) return res.status(401).json({ error: "Add your ElevenLabs API key in Settings > API." });
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key11, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    return res.status(502).json({ error: "Couldn't reach ElevenLabs." });
  }
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    const status = detail?.detail?.status;
    const msg = typeof detail?.detail?.message === "string" ? detail.detail.message : "";
    const error =
      r.status === 401 && status === "invalid_api_key" ? "ElevenLabs rejected your API key. Check it in Settings > API."
      : status === "quota_exceeded" ? "Your ElevenLabs credits are used up."
      : r.status === 401 || r.status === 403 ? `Your ElevenLabs key can't do this${msg ? `: ${msg}` : "."}`
      : r.status === 429 ? "ElevenLabs is busy (too many requests at once)."
      : `ElevenLabs error ${r.status}${msg ? `: ${msg}` : ""}`;
    return res.status(r.status === 429 ? 429 : r.status >= 500 ? 502 : r.status).json({ error });
  }
  const audio = Buffer.from(await r.arrayBuffer());
  res.set("Content-Type", "audio/mpeg").set("Cache-Control", "no-store").send(audio);
}

const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

router.post("/tts", (req, res) => {
  const { text, voiceId, speed, previousText, nextText } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Nothing to say." });
  const voice = typeof voiceId === "string" && VOICE_ID.test(voiceId) ? voiceId : DEFAULT_VOICE;
  const body = {
    text: text.slice(0, 1000),
    model_id: TTS_MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: clamp(Number(speed) || 1, 0.7, 1.2), use_speaker_boost: true },
  };
  if (typeof previousText === "string" && previousText) body.previous_text = previousText.slice(0, 1000);
  if (typeof nextText === "string" && nextText) body.next_text = nextText.slice(0, 1000);
  return relay(res, `${ELEVEN}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, req.get(ELEVENLABS_KEY_HEADER), body);
});

router.post("/sfx", (req, res) => {
  const { prompt, duration } = req.body ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "Describe the sound." });
  return relay(res, `${ELEVEN}/v1/sound-generation?output_format=mp3_44100_128`, req.get(ELEVENLABS_KEY_HEADER), {
    text: prompt.slice(0, 450),
    duration_seconds: clamp(Number(duration) || 1, 0.5, 30),
    prompt_influence: 0.5,
    model_id: SFX_MODEL,
  });
});

router.get("/voices", async (req, res) => {
  const key = cleanKey(req.get(ELEVENLABS_KEY_HEADER));
  if (!key) return res.status(401).json({ error: "Add your ElevenLabs API key in Settings > API." });
  try {
    const r = await fetch(`${ELEVEN}/v2/voices?page_size=100&include_total_count=false`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return res.status(r.status === 401 ? 401 : 502).json({ error: "Couldn't load voices from ElevenLabs." });
    const data = await r.json();
    const voices = (data.voices || []).map((v) => {
      const l = v.labels || {};
      const desc = [l.gender, l.age, l.accent, l.descriptive || l.description, l.use_case].filter(Boolean).join(" · ");
      return { id: v.voice_id, name: v.name, desc, preview: v.preview_url || null, category: v.category };
    });
    res.json({ voices });
  } catch {
    res.status(502).json({ error: "Couldn't reach ElevenLabs." });
  }
});

// ---------- transcription (for uploaded narration) ----------

const STT_MODELS = ["scribe_v2", "scribe_v1"];
const rawAudio = express.raw({ type: () => true, limit: "60mb" });

function explainEleven(status, detail) {
  const code = detail?.detail?.status;
  const msg = typeof detail?.detail?.message === "string" ? detail.detail.message : "";
  if (status === 401 && code === "invalid_api_key") return "ElevenLabs rejected your API key. Check it in Settings > API.";
  if (code === "quota_exceeded") return "Your ElevenLabs credits are used up.";
  if (status === 401 || status === 403) return `Your ElevenLabs key can't transcribe audio${msg ? `: ${msg}` : ". It needs the speech to text permission."}`;
  if (status === 429) return "ElevenLabs is busy. Try again in a moment.";
  if (status === 400 || status === 422) return `ElevenLabs couldn't read this audio${msg ? `: ${msg}` : ". Try an MP3, WAV or M4A file."}`;
  return `ElevenLabs error ${status}${msg ? `: ${msg}` : ""}`;
}

// The audio arrives as the raw request body. Replies { language, text, words: [{ text, start, end }] }.
router.post(
  "/transcribe",
  (req, res, next) => rawAudio(req, res, (err) => {
    if (!err) return next();
    res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "That file is too large. Use one under 60 MB." : "Couldn't read the upload." });
  }),
  async (req, res) => {
    const key = cleanKey(req.get(ELEVENLABS_KEY_HEADER));
    if (!key) return res.status(401).json({ error: "Add your ElevenLabs API key in Settings > API." });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 1000) return res.status(400).json({ error: "No audio was received." });
    const type = (req.get("content-type") || "audio/mpeg").split(";")[0].trim() || "audio/mpeg";

    try {
      let r, detail;
      for (let i = 0; i < STT_MODELS.length; i++) {
        const form = new FormData();
        form.append("model_id", STT_MODELS[i]);
        form.append("timestamps_granularity", "word");
        form.append("tag_audio_events", "false");
        form.append("file", new Blob([body], { type }), "narration");
        r = await fetch(`${ELEVEN}/v1/speech-to-text`, {
          method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(240000),
        });
        if (r.ok) break;
        detail = await r.json().catch(() => ({}));
        // An older account may not have the newest model yet: fall back to the previous one.
        const modelProblem = (r.status === 400 || r.status === 422) && /model/i.test(JSON.stringify(detail));
        if (!modelProblem) break;
      }
      if (!r.ok) {
        return res.status(r.status === 429 ? 429 : r.status >= 500 ? 502 : r.status).json({ error: explainEleven(r.status, detail) });
      }
      const data = await r.json();
      const words = (Array.isArray(data.words) ? data.words : [])
        .filter((w) => w && w.type === "word" && typeof w.text === "string" && w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }));
      if (!words.length) return res.status(422).json({ error: "No speech was found in this audio." });
      res.json({ language: data.language_code ?? null, text: typeof data.text === "string" ? data.text : words.map((w) => w.text).join(" "), words });
    } catch {
      res.status(502).json({ error: "Couldn't reach ElevenLabs." });
    }
  },
);
