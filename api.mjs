// The Claude API route. Vite mounts this as middleware (see vite.config.ts), so one server
// handles both the app and /api/generate.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.mjs";
import { runTeam } from "./team.mjs";
import { pickModel, streamMessage } from "./models.mjs";
import { applyEdits, parseEdits } from "./edits.mjs";

const EFFORTS = new Set(["low", "medium", "high"]);

// API keys come from the user, in request headers, and are used only for that request.
// They are never stored, logged, or echoed back.
const app = express();
const ANTHROPIC_KEY_HEADER = "x-anthropic-key";
const ELEVENLABS_KEY_HEADER = "x-elevenlabs-key";

const cleanKey = (v) => (typeof v === "string" && v.trim().length >= 8 && v.length <= 400 ? v.trim() : "");
const NEEDS_KEY = "Add your Anthropic API key in Settings > API to generate videos.";

app.use(express.json({ limit: "2mb" }));

function buildUserMessage({ prompt, code, error, settings }) {
  const { width, height, duration, fps } = settings;
  const parts = [
    `Video settings: ${width}x${height} pixels, ${duration} seconds, ${fps} fps.`,
  ];
  if (code) parts.push(`<current_code>\n${code}\n</current_code>`);
  if (error) parts.push(`<runtime_error>\n${error}\n</runtime_error>`);
  parts.push(`<request>\n${prompt}\n</request>`);
  return parts.join("\n\n");
}

app.post("/api/generate", async (req, res) => {
  const { prompt, code, error, settings, effort, mode, model } = req.body ?? {};
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
  };

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

  try {
    // Team mode builds new videos. Edits and fixes go to Opus alone, which sees the whole program.
    if (mode === "team" && !currentCode && !runtimeError) {
      const result = await runTeam({
        client,
        prompt: prompt.trim(),
        settings: s,
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
    const request = (content) => ({
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: opusEffort },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    const userContent = buildUserMessage({ prompt: prompt.trim(), code: currentCode, error: runtimeError, settings: s });

    // Streams one answer. Text is forwarded live, except an ```edit block, which is held back
    // so it can be applied to the current code and sent on as a complete program.
    const run = async (content, allowEdits) => {
      const stream = streamMessage(client, modelKey, request(content), { signal: controller.signal });
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
