// Animation styles the user can pick in Settings > Animation. Each one becomes direction in the prompt,
// so solo videos, the team director's plan, and every scene animator share one motion language:
// the same easing, pacing, entrances, transitions and camera behavior.

// How a "camera" works in a Canvas 2D program, shared by every style that moves it.
const CAMERA = `Build any camera move as a transform applied before drawing the world, for example:
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(cam.roll); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
    // ...draw the world in world coordinates...
    ctx.restore();
Animate the camera's x, y, zoom and roll from \`t\` (anime.js timelines or eased \`progress()\` windows), never from per-frame state. Draw text that must stay readable either inside the world on purpose or after \`ctx.restore()\` in screen space. Fill well past the frame edges so moves never reveal empty background.`;

export const ANIMATION_STYLES = {
  auto: { label: "Auto", direction: "" },

  minimal: {
    label: "Minimal",
    direction: `Animation style: MINIMAL.
- Easing: gentle ease-out only (cubic-out / quart-out). No overshoot, no bounce, no elastic.
- Pacing: calm. Element transitions take 0.6–1.0s; hold each idea for at least 1.5s. Few things move at once.
- Entrances: simple fades combined with a small slide (about 2–4% of the frame) or a clean mask/clip reveal. Text fades in by line, not by letter.
- Stagger: even and short (0.08–0.12s) between siblings.
- Transitions between beats: cross-fades or clean wipes. No spins, no flashes.
- Camera: LOCKED. The frame never pans, zooms, rotates or shakes; all motion comes from the elements themselves.
- Feel: lots of negative space, flat shapes, restrained color, like a poster that quietly comes alive.`,
  },

  smooth: {
    label: "Smooth",
    direction: `Animation style: SMOOTH.
- Easing: soft in-out curves (sine / cubic in-out) for almost every move, so everything flows. No overshoot beyond a hint of 3–5%.
- Pacing: unhurried and continuous. Moves take 0.8–1.4s and overlap, so one motion is easing out as the next eases in; nothing ever fully stops.
- Entrances: elements glide, float and scale up from about 92% while fading in. Text rises in by word with a soft blur-to-sharp fade.
- Stagger: 0.1–0.18s, flowing in a consistent direction (for example left to right).
- Transitions between beats: morphs and shared-element movement, long cross-fades, elements sliding out as new ones slide in.
- Camera: subtle. Slow continuous push-in (zoom drifting 3–8% over a shot), light parallax between layers, never any rotation beyond a degree.
- Ambient life: gentle idle motion (slow float, breathing scale of 1–2%) on elements that are on screen so the frame is never dead.`,
  },

  kinetic: {
    label: "Kinetic",
    direction: `Animation style: KINETIC.
- Easing: fast and punchy. Use expo-out / quint-out for entrances and back-out (small overshoot of 8–12%) for emphasis. Exits are quick ease-in.
- Pacing: rapid and rhythmic, on a steady beat (choose a tempo, for example one beat every 0.5s, and land every major change on a beat). Moves take 0.25–0.6s. Cut idea to idea quickly, but each key word or number holds readable for at least 0.8s.
- Entrances: slam, snap and wipe in. Text animates in by word or letter with a short stagger (0.03–0.06s), scale-pops, and mask reveals. Big type, high contrast.
- Emphasis: punch-ins on key beats (a fast 15–40% zoom with expo ease), scale pulses, hard color flips, and short shake-free impact frames.
- Transitions between beats: hard cuts on the beat, whip pans with motion blur faked by drawing trails or stretched copies, and fast slides.
- Camera: dynamic. Purposeful pans and punch-ins that land on beats, small rotations for snap, and always settle before text must be read. No random jitter.

${CAMERA}`,
  },

  playful: {
    label: "Playful",
    direction: `Animation style: PLAYFUL.
- Easing: springy and bouncy. Use back-out and elastic-out for entrances (overshoot 10–20%, settling in 0.5–0.9s), and squash-and-stretch on things that move or land (scale x and y in opposite directions by 8–15%).
- Pacing: lively and bright, with anticipation (a small wind-up in the opposite direction before a big move) and follow-through (a small settle after).
- Entrances: pop in from scale 0, bounce down from above, wiggle on arrival. Text bounces in letter by letter with a wave-like stagger (0.04–0.08s) and gentle rotation (a few degrees).
- Idle: things never sit still; add small bobbing, wobbling, blinking and breathing loops so the frame feels alive.
- Shapes and color: rounded corners, chunky shapes, bright saturated colors, friendly and cartoon-like.
- Transitions between beats: bouncy slides, circle wipes, pop-outs, confetti-style bursts. Fun, never harsh.
- Camera: mostly locked, with an occasional small bounce-zoom for emphasis.`,
  },

  cinematic: {
    label: "Cinematic",
    direction: `Animation style: CINEMATIC.
- Easing: long, deliberate ease-in-out (expo in-out or quart in-out). Slow starts, slow settles, no bounce.
- Pacing: slow and dramatic. One deliberate move per shot, motivated by the story beat. Moves take 1.5–4s. Leave room for held moments and silence.
- Entrances: slow fades from black or darkness, light sweeps and glows revealing subjects, text that fades in with wide letter-spacing slowly tightening. Titles are sparse and elegant.
- Look: strong foreground / midground / background layering with parallax, rack-focus style depth (blur or fade the out-of-focus layer with shadowBlur or reduced alpha), vignette, soft bloom, subtle film grain, letterbox-friendly composition.
- Transitions between beats: dip to black, slow dissolves, match cuts, a push-through. Never flashy.
- Camera: slow dolly and crane moves, long eased push-ins and pull-backs that reveal the scene. Dramatic but never fast or shaky.

${CAMERA}`,
  },

  immersive: {
    label: "Immersive",
    direction: `Animation style: IMMERSIVE (3D depth).
- The viewer travels through the world: fake 3D with perspective projection (scale = focal / (focal + z), screen position = world position × scale), objects arranged in depth that rush past or toward the camera, fly-throughs and tunnels, orbits around a subject, deep multi-layer parallax.
- Depth: sort far to near, and apply distance fog (fade alpha or color with z). Add depth-of-field blur to far or very near elements.
- Easing: smooth acceleration into moves (cubic or expo in-out), with continuous forward motion for most of the video.
- Pacing: steady and sweeping. Moves take 1–3s. Titles and key content hold still in 3D space, or lock to the screen, long enough to read.
- Entrances: elements fly in from depth (large z to their place) while fading in, or assemble from scattered 3D positions.
- Transitions between beats: the camera flies through or past one scene into the next, with no hard cuts.
- Camera: keeps moving forward through space, with gentle banking (a few degrees of roll) on turns. It should feel like flying, not watching a flat slide.

${CAMERA}`,
  },
};

export const pickAnimation = (key) => (Object.hasOwn(ANIMATION_STYLES, key) ? key : "auto");

/** The animation direction for a prompt, or "" when the model should choose. */
export function animationBlock(key) {
  const d = ANIMATION_STYLES[pickAnimation(key)].direction;
  return d
    ? `<animation_style>\nThe user chose this animation style for the video. Follow it for every element, move and transition in every shot, so the whole video shares one consistent motion language. Pick one easing family and one pacing and stick to it; do not mix in other styles.\n\n${d}\n</animation_style>`
    : "";
}
