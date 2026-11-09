// The plan step. Before any code is written, Claude writes a detailed plan for the video, in the open,
// into the app's Plan tab. The user can read and edit it, and the code step then implements it.
// The planning that used to happen in hidden thinking (often including drafts of the whole program)
// happens here instead, once, so the code step can go straight to writing code.

import { CRAFT, HELPERS_DOC, RULES } from "./prompt.mjs";
import { animationBlock } from "./animation.mjs";
import { narrationBlock } from "./narration.mjs";
import { withAttachments } from "./attachments.mjs";
import { streamMessage } from "./models.mjs";

export const PLAN_PROMPT = `You are a motion designer planning a short video. An animator will build it as a deterministic HTML5 Canvas 2D program in plain JavaScript (\`draw(ctx, t)\` paints the frame at time \`t\` seconds; an optional \`setup()\` precomputes data). Your plan is the blueprint. The user sees it and may edit it, and then the animator writes the code from it without planning again.

So do all of the thinking here, on the page: make every creative and technical decision, concretely enough that writing the code is straightforward. Don't write the program itself. A few lines of pseudo-code for a tricky part are fine; a full implementation is not.

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

When the message includes <current_plan>, the video already exists: return the complete updated plan, changing only what the request needs and keeping everything else as it was, word for word. When there is <current_code> but no plan, write the plan for the video as the code makes it now, with the request applied.

Spell any text that must appear on screen exactly as given. Reply with only the plan.`;

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

/**
 * Streams the plan back as server-sent events: { type: "text" } as it is written, then { type: "done" }.
 * No hidden thinking: the plan is the thinking.
 */
export async function streamPlan({ client, model, effort, content, attachments, send, signal }) {
  const stream = streamMessage(client, model, {
    max_tokens: 16000,
    thinking: { type: "disabled" },
    output_config: { effort },
    system: [{ type: "text", text: PLAN_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: withAttachments(content, attachments) }],
  }, { signal });
  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "fallback") send({ type: "restart" });
    else if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
  }
  const message = await stream.finalMessage();
  return message.stop_reason;
}


