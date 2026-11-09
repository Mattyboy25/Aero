// The Claude API route. Vite mounts this as middleware (see vite.config.ts), so one server
// handles both the app and /api/generate.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.mjs";
import { runTeam } from "./team.mjs";
import { pickModel, streamMessage } from "./models.mjs";

const EFFORTS = new Set(["low", "medium", "high"]);

// Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
const client = new Anthropic();
const app = express();

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
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required." });
  }
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

    const stream = streamMessage(
      client,
      modelKey,
      {
        max_tokens: 32000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: opusEffort },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: buildUserMessage({
              prompt: prompt.trim(),
              code: currentCode,
              error: runtimeError,
              settings: s,
            }),
          },
        ],
      },
      { signal: controller.signal }
    );

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        send({ type: "fallback", to: event.content_block.to?.model });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
        else if (event.delta.type === "thinking_delta") send({ type: "thinking", text: event.delta.thinking });
      }
    }
    const message = await stream.finalMessage();
    send({ type: "done", stop_reason: message.stop_reason });
  } catch (err) {
    send({ type: "error", message: describeError(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message ?? "")) {
    return "Authentication failed. Set ANTHROPIC_API_KEY in a .env file and restart the server.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIUserAbortError || err?.name === "AbortError") return "Request cancelled.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err?.message || String(err);
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default app;
