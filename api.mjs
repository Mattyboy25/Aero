// The Claude API route. Vite mounts this as middleware (see vite.config.ts), so one server
// handles both the app and /api/generate.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.mjs";
import { animationBlock, pickAnimation } from "./animation.mjs";
import { runTeam } from "./team.mjs";
import { MODELS, pickModel, streamMessage } from "./models.mjs";
import { applyEdits, parseEdits } from "./edits.mjs";
import { router as audioRouter } from "./audio.mjs";
import { cleanNarration, narrationBlock } from "./narration.mjs";
import { INTENT_PROMPT, INTENT_SCHEMA, cleanQuestions, intentMessage } from "./intent.mjs";
import { cleanAttachments, withAttachments } from "./attachments.mjs";
import { planMessage, streamPlan } from "./plan.mjs";

const EFFORTS = new Set(["low", "medium", "high"]);

// API keys come from the user, in request headers, and are used only for that request.
// They are never stored, logged, or echoed back.
const app = express();
const ANTHROPIC_KEY_HEADER = "x-anthropic-key";
const ELEVENLABS_KEY_HEADER = "x-elevenlabs-key";

const cleanKey = (v) => (typeof v === "string" && v.trim().length >= 8 && v.length <= 400 ? v.trim() : "");
const NEEDS_KEY = "Add your Anthropic API key in Settings > API to generate videos.";

app.use(express.json({ limit: "40mb" }));
app.use("/api/audio", audioRouter);

function buildUserMessage({ prompt, code, error, settings, narration, plan }) {
  const { width, height, duration, fps } = settings;
  const parts = [
    `Video settings: ${width}x${height} pixels, ${duration} seconds, ${fps} fps.`,
  ];
  const animation = animationBlock(settings.animation);
  if (animation) parts.push(animation);
  if (narration) parts.push(narrationBlock(narration, duration));
  if (plan) parts.push(`<plan>\n${plan}\n</plan>`);
  if (code) parts.push(`<current_code>\n${code}\n</current_code>`);
  if (error) parts.push(`<runtime_error>\n${error}\n</runtime_error>`);
  parts.push(`<request>\n${prompt}\n</request>`);
  return parts.join("\n\n");
}

app.post("/api/generate", async (req, res) => {
  const { prompt, code, error, settings, effort, mode, model, narration: rawNarration, attachments: rawAttachments, resume, plan: rawPlan } = req.body ?? {};
  const modelKey = pickModel(model);
  const apiKey = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
  if (!apiKey) return res.status(401).json({ error: NEEDS_KEY });
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required." });
  }
  const client = new Anthropic({ apiKey });
  const s = {
    width: clampInt(settings?.width, 320, 3840, 1920),
    height: clampInt(settings?.height, 320, 3840, 1080),
    duration: clampInt(settings?.duration, 1, 60, 8),
    fps: clampInt(settings?.fps, 12, 60, 30),
    animation: pickAnimation(settings?.animation),
  };

  const narration = cleanNarration(rawNarration, s.duration);
  const attachments = cleanAttachments(rawAttachments);

  // Server-sent events back to the browser.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}

`);
  };

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const opusEffort = EFFORTS.has(effort) ? effort : "medium";
  const currentCode = typeof code === "string" ? code : "";
  const runtimeError = typeof error === "string" ? error : "";
  // A reply that was cut off (or stopped), to be continued from where it ended.
  const resumeRaw = typeof resume?.text === "string" ? resume.text.slice(0, 600000) : "";
  // The plan from the plan step (or the user's edit of it). With one, the planning is done, so the
  // code step skips hidden thinking and writes the code directly.
  const plan = typeof rawPlan === "string" ? rawPlan.trim().slice(0, 60000) : "";

  try {
    // Team mode builds new videos. Edits and fixes go to Opus alone, which sees the whole program.
    if (mode === "team" && !currentCode && !runtimeError && !resumeRaw) {
      const result = await runTeam({
        client,
        prompt: prompt.trim(),
        settings: s,
        narration,
        attachments,
        plan,
        model: modelKey,
        effort: opusEffort,
        send,
        signal: controller.signal,
      });
      const fence = "`".repeat(3);
      send({ type: "text", text: result.summary + "\n\n" + fence + "javascript\n" + result.code + fence });
      send({ type: "done", stop_reason: "end_turn" });
      return;
    }

    const fence = "`".repeat(3);
    // `tail` is the rest of a conversation, used to continue a reply that was cut off. Continuing is
    // plain code writing, so it skips thinking and spends the whole budget on the code.
    const request = (content, tail = []) => ({
      max_tokens: 32000,
      thinking: tail.length || plan ? { type: "disabled" } : { type: "adaptive", display: "summarized" },
      output_config: { effort: opusEffort },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: withAttachments(content, attachments) }, ...tail],
    });
    const userContent = buildUserMessage({ prompt: prompt.trim(), code: currentCode, error: runtimeError, settings: s, narration, plan });

    // Streams one answer. Text is forwarded live, except an ```edit block, which is held back
    // so it can be applied to the current code and sent on as a complete program.
    const run = async (content, allowEdits, tail = []) => {
      const stream = streamMessage(client, modelKey, request(content, tail), { signal: controller.signal });
      let raw = "";
      let sent = 0;
      let editing = false;
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "fallback") {
          send({ type: "fallback", to: event.content_block.to?.model });
          raw = ""; sent = 0; editing = false;
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "thinking_delta") send({ type: "thinking", text: event.delta.thinking });
          else if (event.delta.type === "text_delta") {
            raw += event.delta.text;
            if (editing) continue;
            const open = raw.match(/```([a-zA-Z]*)[ \t]*\n/);
            if (allowEdits && open && open[1] === "edit") {
              editing = true;
              if (open.index > sent) send({ type: "text", text: raw.slice(sent, open.index) });
              sent = raw.length;
              send({ type: "editing" });
              continue;
            }
            // Until a fence opener is complete, hold back a trailing partial one.
            const hold = open ? -1 : raw.search(/`{1,3}[a-zA-Z]*[ \t]*$/);
            const upto = hold === -1 ? raw.length : hold;
            if (upto > sent) { send({ type: "text", text: raw.slice(sent, upto) }); sent = upto; }
          }
        }
      }
      const message = await stream.finalMessage();
      if (!editing && raw.length > sent) send({ type: "text", text: raw.slice(sent) });
      return { raw, editing, stop: message.stop_reason };
    };

    if (resumeRaw) {
      // Keep everything up to the last whole line: a line cut off halfway is written again.
      const cut = resumeRaw.lastIndexOf("\n");
      const kept = (cut === -1 ? "" : resumeRaw.slice(0, cut)).trimEnd();
      if (!/```[a-zA-Z]*[ \t]*\n[\s\S]*\S/.test(kept)) {
        send({ type: "error", message: "There's no code to continue from." });
        return;
      }
      const lastLine = kept.slice(kept.lastIndexOf("\n") + 1);
      send({ type: "base", text: kept });
      const tail = [
        { role: "assistant", content: kept },
        {
          role: "user",
          content: `Your reply was cut off before the program was finished. Continue it from exactly where it stopped, starting with the very next line after this last line:\n\n${lastLine}\n\nReply with only the remaining code: no explanation, no new code fence, and don't repeat any line you already wrote. Finish the program, then close the code block with ${fence}.`,
        },
      ];
      const continued = await run(userContent, false, tail);
      send({ type: "done", stop_reason: continued.stop });
      return;
    }

    let result = await run(userContent, !!currentCode);
    if (result.editing && result.stop !== "refusal") {
      const open = result.raw.match(/```edit[ \t]*\n/);
      const rest = result.raw.slice(open.index + open[0].length);
      const close = rest.lastIndexOf(fence);
      const applied = applyEdits(currentCode, parseEdits(close === -1 ? rest : rest.slice(0, close)));
      if (applied.code) {
        send({ type: "text", text: "\n\n" + fence + "javascript\n" + applied.code + fence });
        send({ type: "done", stop_reason: "end_turn" });
        return;
      }
      // The edits didn't line up with the code. Ask once more for the complete program.
      send({ type: "retry" });
      result = await run(
        userContent + `\n\n<edit_failed>\nYour targeted edits could not be applied (${applied.error}). Reply with the complete updated program in a single ${fence}javascript block instead.\n</edit_failed>`,
        false
      );
    }
    send({ type: "done", stop_reason: result.stop });
  } catch (err) {
    send({ type: "error", message: describeError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message ?? "")) {
    return "Anthropic rejected your API key. Check it in Settings > API.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "Your Anthropic API key doesn't have access to this model. Check your key's permissions in Settings > API.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIUserAbortError || err?.name === "AbortError") return "Request cancelled.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}

// Writes (or updates) the plan for a video, streamed so the Plan tab fills in as it is written.
app.post("/api/plan", async (req, res) => {
  const apiKey = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
  if (!apiKey) return res.status(401).json({ error: NEEDS_KEY });
  const { request, settings, effort, model, narration: rawNarration, attachments: rawAttachments, currentPlan, currentCode } = req.body ?? {};
  if (typeof request !== "string" || !request.trim()) return res.status(400).json({ error: "Request is required." });
  const s = {
    width: clampInt(settings?.width, 320, 3840, 1920),
    height: clampInt(settings?.height, 320, 3840, 1080),
    duration: clampInt(settings?.duration, 1, 60, 8),
    fps: clampInt(settings?.fps, 12, 60, 30),
    animation: pickAnimation(settings?.animation),
  };
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const content = planMessage({
      request: request.trim().slice(0, 8000), settings: s, narration: cleanNarration(rawNarration, s.duration),
      currentPlan: typeof currentPlan === "string" ? currentPlan.slice(0, 60000) : "",
      currentCode: typeof currentCode === "string" ? currentCode.slice(0, 200000) : "",
    });
    const stop = await streamPlan({
      client: new Anthropic({ apiKey }), model: pickModel(model), effort: EFFORTS.has(effort) ? effort : "medium",
      content, attachments: cleanAttachments(rawAttachments), send, signal: controller.signal,
    });
    send({ type: "done", stop_reason: stop });
  } catch (err) {
    send({ type: "error", message: describeError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// Reads the conversation and decides whether to reply, ask questions, or build. On any failure
// other than a bad key it says "build" with the user's own words, so a request is never lost.
app.post("/api/intent", async (req, res) => {
  const apiKey = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
  if (!apiKey) return res.status(401).json({ error: NEEDS_KEY });
  const { message, history, code, settings, model, attachments: rawAttachments } = req.body ?? {};
  const attachments = cleanAttachments(rawAttachments);
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "Message is required." });
  const fallback = { action: "build", message: "", questions: [], brief: message.trim(), fallback: true };
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45000 });
    const reply = await client.messages.create({
      model: MODELS[pickModel(model)].id,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: INTENT_SCHEMA } },
      system: [{ type: "text", text: INTENT_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: withAttachments(intentMessage({ message: message.trim(), history, code: typeof code === "string" ? code : "", settings }), attachments) }],
    });
    if (reply.stop_reason === "refusal") return res.json({ action: "reply", message: "I can't help with that one. Want to try a different idea?", questions: [], brief: "" });
    const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const d = JSON.parse(text);
    const questions = cleanQuestions(d.questions);
    const out = {
      action: ["reply", "ask", "build"].includes(d.action) ? d.action : "build",
      message: typeof d.message === "string" ? d.message.slice(0, 2000).trim() : "",
      questions,
      brief: typeof d.brief === "string" ? d.brief.slice(0, 6000).trim() : "",
    };
    // A question round with nothing usable to pick from, or a build without a brief, falls back sensibly.
    if (out.action === "ask" && !questions.length) out.action = out.message ? "reply" : "build";
    if (out.action === "build" && !out.brief) out.brief = message.trim();
    if (out.action === "reply" && !out.message) return res.json(fallback);
    res.json(out);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return res.status(401).json({ error: describeError(err) });
    if (err instanceof Anthropic.APIUserAbortError) return;
    res.json(fallback);
  }
});

// "Auto" length: a quick request that decides how long a video should be, never past the user's maximum.
const LENGTH_PROMPT = `You decide how long a short motion-graphics video should be, in whole seconds. Weigh how many ideas or beats the request has, how much text must be read (viewers read about 3 words a second, and need a beat to take in each title), how much needs to move on screen, and the kind of piece: a logo sting or simple loop is 4-8 seconds, a teaser or announcement 8-15, a product explainer or short story 15-30, and anything richer longer. Don't pad: a tight video beats a long one. If the request names a length ("a 20 second intro"), use it. The maximum is a hard limit; never go over it. When the message says this is an edit of an existing video, keep its current length unless the request clearly adds or removes content, or asks for it to be longer or shorter.`;
const LENGTH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["seconds", "reason"],
  properties: { seconds: { type: "integer" }, reason: { type: "string" } },
};

app.post("/api/length", async (req, res) => {
  const apiKey = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
  if (!apiKey) return res.status(401).json({ error: NEEDS_KEY });
  const { prompt, current, max } = req.body ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "Prompt is required." });
  const maxSec = clampInt(max, 3, 60, 30);
  const cur = Number(current) > 0 ? clampInt(current, 1, 60, 8) : null;
  const fallback = Math.min(maxSec, cur ?? 10);
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20000 });
    const message = await client.messages.create({
      model: MODELS.haiku.id,
      max_tokens: 400,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: LENGTH_SCHEMA } },
      system: LENGTH_PROMPT,
      messages: [{
        role: "user",
        content: [
          `Maximum length: ${maxSec} seconds.`,
          cur ? `This is an edit of an existing ${cur}-second video.` : "This is a new video.",
          `<request>\n${prompt.slice(0, 4000)}\n</request>`,
        ].join("\n\n"),
      }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const picked = JSON.parse(text);
    // The limit is enforced here, whatever the model says.
    res.json({ seconds: clampInt(picked.seconds, 3, maxSec, fallback), reason: typeof picked.reason === "string" ? picked.reason.slice(0, 200) : "" });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return res.status(401).json({ error: describeError(err) });
    res.json({ seconds: fallback, reason: "Couldn't pick a length, so it used a default.", fallback: true });
  }
});

// Checks a key with the provider so the Settings page can tell the user right away.
// Replies { status: "valid" | "invalid" | "unknown", message }.
app.post("/api/keys/check/:provider", async (req, res) => {
  const { provider } = req.params;
  const send = (status, message) => res.json({ status, message });
  try {
    if (provider === "anthropic") {
      const key = cleanKey(req.get(ANTHROPIC_KEY_HEADER));
      if (!key) return send("invalid", "Enter your key first.");
      try {
        await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.list({ limit: 1 });
        return send("valid", "Key accepted.");
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return send("invalid", "Anthropic rejected this key.");
        if (err instanceof Anthropic.PermissionDeniedError) return send("valid", "Key accepted, with limited permissions.");
        return send("unknown", "Couldn't reach Anthropic to check this key. It was saved, and will be tried on your next request.");
      }
    }
    if (provider === "elevenlabs") {
      const key = cleanKey(req.get(ELEVENLABS_KEY_HEADER));
      if (!key) return send("invalid", "Enter your key first.");
      try {
        const r = await fetch("https://api.elevenlabs.io/v1/user", {
          headers: { "xi-api-key": key },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) return send("valid", "Key accepted.");
        const body = await r.json().catch(() => ({}));
        if (r.status === 401 && body?.detail?.status === "invalid_api_key") return send("invalid", "ElevenLabs rejected this key.");
        if (r.status === 401 || r.status === 403) return send("valid", "Key accepted, with limited permissions.");
        return send("unknown", "ElevenLabs couldn't confirm this key right now. It was saved.");
      } catch {
        return send("unknown", "Couldn't reach ElevenLabs to check this key. It was saved.");
      }
    }
    return res.status(404).json({ error: "Unknown provider." });
  } catch {
    return send("unknown", "Couldn't check this key.");
  }
});

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default app;
