import { animationBlock } from "./animation.mjs";
// Team mode: the chosen Claude model (Opus by default) plans the video as a shot list, then one Claude Haiku
// call per scene writes that scene's animation in parallel. The scenes are
// stitched into a single program with a timeline and transitions.
import {
  DIRECTOR_PROMPT,
  DIRECTOR_SCHEMA,
  SCENE_PROMPT,
} from "./prompt.mjs";
import { streamMessage } from "./models.mjs";
import { narrationBlock } from "./narration.mjs";

const SCENE_MODEL = "claude-haiku-5-5";
const MAX_SCENES = 6;
const SCENE_ATTEMPTS = 2;

export async function runTeam({ client, prompt, settings, narration, model, effort, send, signal }) {
  send({ type: "phase", phase: "planning" });
  const plan = await direct({ client, prompt, settings, narration, model, effort, send, signal });

  send({
    type: "plan",
    title: plan.title,
    scenes: plan.scenes.map(({ start, end, title }) => ({ start, end, title })),
  });
  send({ type: "phase", phase: "animating" });

  const codes = await Promise.all(
    plan.scenes.map((scene, index) =>
      writeScene({ client, prompt, settings, narration, plan, index, send, signal })
    )
  );

  return { summary: plan.summary, code: assemble(plan, codes) };
}

// ---------- director (the chosen model) ----------

async function direct({ client, prompt, settings, narration, model, effort, send, signal }) {
  const { width, height, duration, fps } = settings;
  const content = [
    `Video settings: ${width}x${height} pixels, DURATION = ${duration} seconds, ${fps} fps.`,
    animationBlock(settings.animation),
    narration ? narrationBlock(narration, duration) : "",
    `<request>\n${prompt}\n</request>`,
  ].filter(Boolean).join("\n\n");

  const stream = streamMessage(
    client,
    model,
    {
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort, format: { type: "json_schema", schema: DIRECTOR_SCHEMA } },
      system: [{ type: "text", text: DIRECTOR_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    },
    { signal }
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      send({ type: "thinking", text: event.delta.thinking });
    }
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Claude declined this request. Try rephrasing it.");
  if (message.stop_reason === "max_tokens") throw new Error("The plan was cut off. Try a shorter or simpler video.");

  // If a fallback model took over, only its text is the answer.
  const lastFallback = message.content.findLastIndex((b) => b.type === "fallback");
  const text = message.content
    .slice(lastFallback + 1)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("The director's plan couldn't be read. Try again.");
  }
  plan.scenes = normalizeScenes(plan.scenes, duration);
  return plan;
}

// Makes the scenes cover 0..duration exactly, in order, with sane transitions.
function normalizeScenes(scenes, duration) {
  const list = (Array.isArray(scenes) ? scenes : [])
    .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_SCENES);
  if (!list.length) throw new Error("The director's plan had no scenes. Try again.");

  const lengths = list.map((s) => Math.max(0.3, s.end - s.start));
  const scale = duration / lengths.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return list.map((s, i) => {
    const start = round(cursor);
    cursor = i === list.length - 1 ? duration : cursor + lengths[i] * scale;
    const end = round(cursor);
    return { ...s, start, end, title: oneLine(s.title || `Scene ${i + 1}`) };
  }).map((s, i, all) => {
    let type = i === 0 ? "cut" : s.transition_in;
    if (!["cut", "crossfade", "fade_black"].includes(type)) type = "cut";
    const room = i === 0 ? 0 : Math.min(s.end - s.start, all[i - 1].end - all[i - 1].start);
    const seconds = type === "cut" ? 0 : round(clampNum(s.transition_seconds, 0.1, Math.min(1.2, room * 0.8)));
    return { ...s, transition_in: type, transition_seconds: seconds };
  });
}

// ---------- scene animators (Haiku, in parallel) ----------

async function writeScene({ client, prompt, settings, narration, plan, index, send, signal }) {
  const scene = plan.scenes[index];
  let previous = null;

  for (let attempt = 1; attempt <= SCENE_ATTEMPTS; attempt++) {
    send({ type: "scene", index, status: attempt === 1 ? "writing" : "retrying" });
    try {
      const stream = client.messages.stream(
        {
          model: SCENE_MODEL,
          max_tokens: 32000,
          output_config: { effort: "medium" },
          system: [{ type: "text", text: SCENE_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: sceneMessage({ prompt, settings, narration, plan, index, previous }) }],
        },
        { signal }
      );
      let raw = "";
      let lastLines = 0;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          raw += event.delta.text;
          const lines = raw.split("\n").length;
          if (lines - lastLines >= 5) {
            lastLines = lines;
            send({ type: "scene", index, status: "writing", lines });
          }
        }
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") throw new SceneError("declined", "");
      const code = extractCode(raw);
      if (!code) throw new SceneError("returned no code", raw);
      const problem = syntaxError(`const SCENE_DURATION = 1;\n${code}\n;return draw;`);
      if (problem) throw new SceneError(`has a syntax error: ${problem}`, code);
      if (!/function\s+draw\s*\(/.test(code)) throw new SceneError("doesn't define function draw(ctx, lt)", code);

      send({ type: "scene", index, status: "done", lines: code.split("\n").length });
      return code;
    } catch (err) {
      if (signal.aborted) throw err;
      previous = err instanceof SceneError ? err : new SceneError(`failed: ${err.message}`, "");
    }
  }

  send({ type: "scene", index, status: "failed", error: previous?.reason });
  return placeholderScene(scene);
}

class SceneError extends Error {
  constructor(reason, code) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

function sceneMessage({ prompt, settings, narration, plan, index, previous }) {
  const { width, height, duration, fps } = settings;
  const scene = plan.scenes[index];
  const next = plan.scenes[index + 1];
  const list = plan.scenes
    .map((s, i) => `${i + 1}. ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s "${s.title}"${i === index ? "  ← your scene" : ""}`)
    .join("\n");
  const enter = index === 0 ? "it opens the video" : describeTransition(scene);
  const exit = next ? `the next scene enters with ${describeTransition(next)}` : "it ends the video";

  const parts = [
    `Video settings: ${width}x${height} pixels, ${duration} seconds total, ${fps} fps.`,
    animationBlock(settings.animation),
    `<request>\n${prompt}\n</request>`,
    `<style_guide>\n${plan.style_guide}\n</style_guide>`,
    `<shared_code>\n${plan.shared_code}\n</shared_code>`,
    `<scene_list>\n${list}\n</scene_list>`,
    `<your_scene>\nScene ${index + 1} of ${plan.scenes.length}: "${scene.title}". SCENE_DURATION = ${round(scene.end - scene.start)} seconds. Entering: ${enter}. Leaving: ${exit}.\n\n${scene.brief}\n</your_scene>`,
  ];
  if (narration) parts.push(narrationBlock(narration, duration, { from: scene.start, to: scene.end }));
  if (previous) {
    parts.push(
      `<previous_attempt>\nYour previous attempt ${previous.reason}. Write the scene again and fix that.` +
      (previous.code ? `\n\n${previous.code}` : "") +
      `\n</previous_attempt>`
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

function describeTransition(s) {
  if (s.transition_in === "cut") return "a hard cut";
  const name = s.transition_in === "crossfade" ? "a crossfade" : "a fade through black";
  return `${name} of ${s.transition_seconds}s centered on the scene boundary`;
}

// Stand-in for a scene that couldn't be written, so the rest of the video still plays.
function placeholderScene(scene) {
  return `function draw(ctx, lt) {
  const u = Math.min(W, H) / 1000;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = (40 * u) + "px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(${JSON.stringify(`Scene "${scene.title}" couldn't be generated`)}, W / 2, H / 2);
}`;
}

// ---------- assembly ----------

function assemble(plan, codes) {
  const parts = [
    `// ${oneLine(plan.title || "Untitled")}`,
    `// Directed by Claude Opus, scenes animated in parallel by Claude Haiku.`,
    ``,
    `// ---------- shared (from the director) ----------`,
    plan.shared_code.trim(),
  ];

  plan.scenes.forEach((s, i) => {
    // Decide this from the source: a runtime `typeof setup` check would find the timeline's own setup.
    const hasSetup = /\b(function\s+setup\s*\(|(const|let|var)\s+setup\s*=)/.test(codes[i]);
    parts.push(
      ``,
      `// ---------- scene ${i + 1}: ${s.title} (${s.start}s–${s.end}s) ----------`,
      `const __scene${i + 1} = (() => {`,
      `const SCENE_DURATION = ${round(s.end - s.start)};`,
      codes[i].trim(),
      `return { setup: ${hasSetup ? "setup" : "null"}, draw };`,
      `})();`
    );
  });

  const table = plan.scenes
    .map((s, i) => `  { n: ${i + 1}, name: ${JSON.stringify(s.title)}, start: ${s.start}, end: ${s.end}, inType: "${s.transition_in}", inDur: ${s.transition_seconds}, s: __scene${i + 1} },`)
    .join("\n");

  parts.push(``, `// ---------- timeline ----------`, `const __SCENES = [\n${table}\n];`, TIMELINE);
  return parts.join("\n") + "\n";
}

const TIMELINE = `
function __run(sc, fn) {
  try {
    return fn();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.message = "[scene " + sc.n + ": " + sc.name + "] " + err.message;
    throw err;
  }
}

function setup() {
  for (const sc of __SCENES) if (sc.s.setup) __run(sc, () => sc.s.setup());
}

function __render(c, i, t) {
  const sc = __SCENES[i];
  __run(sc, () => sc.s.draw(c, t - sc.start));
}

function draw(ctx, t) {
  let i = __SCENES.findIndex((sc) => t < sc.end);
  if (i < 0) i = __SCENES.length - 1;
  const sc = __SCENES[i];
  const next = __SCENES[i + 1];

  // Transitions are centered on the boundary between two scenes.
  let into = -1;
  if (i > 0 && sc.inDur > 0 && t < sc.start + sc.inDur / 2) into = i;
  else if (next && next.inDur > 0 && t >= next.start - next.inDur / 2) into = i + 1;
  if (into < 0) {
    __render(ctx, i, t);
    return;
  }

  const to = __SCENES[into];
  const k = clamp((t - (to.start - to.inDur / 2)) / to.inDur, 0, 1);
  if (to.inType === "crossfade") {
    const a = layer("__from");
    __render(a, into - 1, t);
    composite(ctx, a);
    const b = layer("__to");
    __render(b, into, t);
    composite(ctx, b, { alpha: ease.inOutSine(k) });
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const half = k < 0.5;
    const l = layer(half ? "__from" : "__to");
    __render(l, half ? into - 1 : into, t);
    composite(ctx, l, { alpha: half ? 1 - ease.inOutSine(k * 2) : ease.inOutSine(k * 2 - 1) });
  }
}`;

// ---------- utilities ----------

function extractCode(raw) {
  const m = raw.match(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n?```/);
  return m ? m[1].trim() : "";
}

// Parses (never runs) the code to catch syntax errors.
function syntaxError(code) {
  try {
    new Function(code);
    return null;
  } catch (e) {
    return e.message;
  }
}

const round = (n) => Math.round(n * 1000) / 1000;
const clampNum = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 80);
