// The plan step. Before any code is written, Claude writes a detailed plan for the video, in the open,
// into the app's Plan tab. The user can read and edit it, and the code step then implements it.
// The planning that used to happen in hidden thinking (often including drafts of the whole program)
// happens here instead, once, so the code step can go straight to writing code.

import { CRAFT, HELPERS_DOC, RULES } from "./prompt.mjs";
import { animationBlock } from "./animation.mjs";
import { narrationBlock } from "./narration.mjs";
import { withAttachments } from "./attachments.mjs";
import { streamMessage } from "./models.mjs";
import { applyEdits, parseEdits } from "./edits.mjs";

export const PLAN_PROMPT = `You are a motion designer planning a short video. An animator will build it as a deterministic HTML5 Canvas 2D program in plain JavaScript (\`draw(ctx, t)\` paints the frame at time \`t\` seconds; an optional \`setup()\` precomputes data). Your plan is the blueprint. The user sees it and may edit it, and then the animator writes the code from it without planning again.

So do all of the thinking here, on the page: make every creative and technical decision, concretely enough that writing the code is straightforward. Keep any private reasoning before you write brief; the plan itself is where the thinking belongs. Don't write the program itself. A few lines of pseudo-code for a tricky part are fine; a full implementation is not.

## What the animator has

${HELPERS_DOC}

## Rules the program must follow

${RULES}

## Craft

${CRAFT}

## Format

Write Markdown, with these sections:

# <A short title>
One short paragraph: the concept, the mood, and the arc (an opening, a main beat, a resolved ending, or a seamless loop when that suits the request).

## Look
- Palette: every color as a hex value, with what it is for.
- Background: what fills the frame and how it moves.
- Typography: font stacks, weights, and sizes as multiples of \`u = Math.min(W, H) / 1000\`.
- Layout: where things sit, as fractions of W and H, with safe margins for the aspect ratio.

## Timeline
Every beat in order, with exact start and end times in seconds, covering the whole video from 0 to the end with nothing missing. For each beat: what is on screen, what moves and how, how things enter and leave, and the exact text shown.

## Elements
Each recurring element: what it is, how it is drawn (shapes, paths, gradients, FX calls with their options), its size in u, and how it changes over time.

## Motion
The easing language, staggers, springs, the camera (follow the animation style if one is given), and the transitions between beats.

## Build notes
How to structure the program: what \`setup()\` precomputes, the anime.js timelines (target, properties, duration, ease, start in ms), FX calls and their options, helper functions to write, and anything that is easy to get wrong.

## Edits

When the message includes <current_plan>, the video already exists. Change only what the request needs and keep everything else as it was, word for word. You have two ways to answer:

1. **Targeted edits (preferred when only part of the plan changes).** Reply with exactly one \`\`\`edit block of SEARCH/REPLACE blocks, and nothing else:

\`\`\`edit
<<<<<<< SEARCH
exact lines copied from the current plan
=======
the lines that replace them
>>>>>>> REPLACE
\`\`\`

   - SEARCH must be copied character for character from <current_plan> and match exactly one place. Include enough neighbouring lines to make it unique, but keep it short.
   - Use several blocks for several separate changes; they are applied in order. To add lines, SEARCH for a nearby line and repeat it in REPLACE with the new lines. To remove lines, leave REPLACE empty.
   - Keep the plan consistent: if a change moves a beat's timing, update every place that depends on it (the timeline, the build notes).
2. **Full rewrite.** For sweeping changes (a new concept, a new look, most sections changing), reply with the complete updated plan.

Pick whichever needs fewer lines. When there is <current_code> but no plan, write the whole plan for the video as the code makes it now, with the request applied.

Spell any text that must appear on screen exactly as given. Reply with only the plan or the edit block.`;

export function planMessage({ request, settings, narration, currentPlan, currentCode }) {
  const { width, height, duration, fps } = settings;
  const parts = [`Video settings: ${width}x${height} pixels, ${duration} seconds, ${fps} fps.`];
  const animation = animationBlock(settings.animation);
  if (animation) parts.push(animation);
  if (narration) parts.push(narrationBlock(narration, duration));
  if (currentPlan) parts.push(`<current_plan>\n${currentPlan}\n</current_plan>`);
  if (currentCode) parts.push(`<current_code>\n${currentCode}\n</current_code>`);
  parts.push(`<request>\n${request}\n</request>`);
  return parts.join("\n\n");
}

const FENCE = "`".repeat(3);
const EDIT_OPEN = FENCE + "edit";

/**
 * Streams the plan back as server-sent events. A full plan streams as { type: "text" } pieces. Targeted
 * edits stream as { type: "editing" }, are applied here to the current plan, and the result is sent as
 * one { type: "replace", text } with the whole updated plan. If they don't apply, Claude is asked once
 * more for the full plan ({ type: "restart" }, then text). The plan is meant to be the thinking, so the
 * prompt asks for it to happen on the page; hidden thinking (adaptive, as the models require) stays short.
 */
export async function streamPlan({ client, model, effort, content, attachments, currentPlan, send, signal }) {
  const run = async (text, allowEdits) => {
    const stream = streamMessage(client, model, {
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system: [{ type: "text", text: PLAN_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: withAttachments(text, attachments) }],
    }, { signal });
    let raw = "";
    let sent = 0;
    // null until the reply's opening shows whether it is a full plan or an edit block
    let mode = allowEdits ? null : "full";
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        send({ type: "restart" });
        raw = ""; sent = 0; mode = allowEdits ? null : "full";
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        raw += event.delta.text;
        if (mode === null) {
          const head = raw.trimStart();
          if (head.length < EDIT_OPEN.length && EDIT_OPEN.startsWith(head)) continue; // could still be an edit block
          mode = head.startsWith(EDIT_OPEN) ? "edit" : "full";
          if (mode === "edit") send({ type: "editing" });
        }
        if (mode === "full" && raw.length > sent) { send({ type: "text", text: raw.slice(sent) }); sent = raw.length; }
      }
    }
    const message = await stream.finalMessage();
    if (mode !== "edit" && raw.length > sent) send({ type: "text", text: raw.slice(sent) });
    return { raw, mode, stop: message.stop_reason };
  };

  let result = await run(content, !!currentPlan);
  if (result.mode === "edit" && result.stop !== "refusal") {
    const open = result.raw.match(/```edit[ \t]*\n/);
    const body = open ? result.raw.slice(open.index + open[0].length) : "";
    const close = body.lastIndexOf(FENCE);
    const applied = applyEdits(currentPlan, parseEdits(close === -1 ? body : body.slice(0, close)));
    if (applied.code) {
      send({ type: "replace", text: applied.code });
      return "end_turn";
    }
    // The edits didn't line up with the plan: ask once more, for the whole plan.
    send({ type: "restart" });
    result = await run(`${content}\n\n<edit_failed>\nYour edits to the plan could not be applied (${applied.error}). Reply with the complete updated plan instead.\n</edit_failed>`, false);
  }
  return result.stop;
}


