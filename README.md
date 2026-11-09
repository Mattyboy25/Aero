# Aero

Type a prompt, get a video. Claude writes the video as a canvas animation in JavaScript. The app plays it in a live preview, lets you refine it with follow-up messages, and exports it to MP4.

## Setup

1. Install Node 20.6 or newer.
2. Install dependencies:
   ```
   npm install
   ```
3. Start the app in development mode (with hot reload):
   ```
   npm run dev
   ```
4. Open http://localhost:3000 in Chrome, Edge, or Safari.
5. Open **Settings > API** (from the user menu at the bottom of the sidebar) and add your Anthropic API key, from https://platform.claude.com/settings/keys. You need it to generate videos. An ElevenLabs key goes there too, for the Voice and Sound effects settings.

For production, `npm start` builds the app into `dist/` and serves it with `vite preview`.

## How it works

- **[vite.config.ts](vite.config.ts)** runs everything on Vite: it serves the app and mounts the Claude API as middleware, in both `npm run dev` and `npm start` (`vite preview`). It also loads your `.env`.
- **[api.mjs](api.mjs)** handles `/api/generate`. It takes the prompt, the current code (for edits), and the video settings, and streams Claude's reply back to the browser. It uses adaptive thinking, and if a safety classifier declines a request, it retries on a fallback model.
- **[team.mjs](team.mjs)** runs Team mode. The chosen model (Opus by default) plans the video as a shot list, with a style guide, shared code (palette and helpers), and timed scenes. Then each scene goes to its own Claude Haiku call, and all of them run at the same time. Scene code with a syntax error is retried once, with the error included. The scenes are then joined into one program, with cuts, crossfades, or fades through black between them.
- **[prompt.mjs](prompt.mjs)** is the system prompt. It defines the program contract: a `draw(ctx, t)` function that paints the frame at time `t` and depends only on `t`, plus helpers such as easing, seeded randomness, and noise.
- **[public/runtime.html](public/runtime.html)** runs the generated code inside a sandboxed iframe, so it can't reach the main page.
  - It gives the generated code two animation libraries. **anime.js** (v4, MIT) handles choreography: Claude animates plain objects on a timeline and seeks it to each frame's time, so scrubbing and export stay exact. **FX** ([public/runtime-fx.js](public/runtime-fx.js)) has animated backgrounds (aurora, plasma, silk, orbs, dot grid) and text effects (split-reveal, shiny, scramble, counters) in the style of React Bits. They are original implementations drawn from the video's time, because React Bits components run live in the page and can't be stepped frame by frame for export.
  - The anime.js bundle is copied into `public/vendor/` by `npm install` (see [scripts/copy-vendor.mjs](scripts/copy-vendor.mjs)).
- **[src/](src/)** is the React + TypeScript front end.
  - [App.tsx](src/App.tsx) holds the projects, the generation stream, playback, and export.
  - [components/](src/components/) has the sidebar (videos and theme), the preview with its loading effect, the code editor, the chat, and the export dialog.
  - [lib/exportMp4.ts](src/lib/exportMp4.ts) renders each frame exactly, encodes it as H.264 with WebCodecs, and packs the result into an MP4 with `mp4-muxer`. Because frames are rendered one at a time, none get dropped.

## Using it

- The **sidebar** on the left lists your videos. Use **New video** to start another, hover a video to delete it, and switch between Light, Dark, and System themes at the bottom. Collapse it to an icon rail with the button at its top.
- The **chat** is on the right. Engine and Effort sit under the message box.
- **Format / Length / FPS** (above the preview) set the output video. The code scales with the canvas, so you can change the format after generating.
- **API keys** are entered in **Settings > API**. They are encrypted in your browser and sent with each request to this app's server, which uses them for that request only. The server never stores or logs them. If you host the app online, use HTTPS. The `.env` file is only for options like `PORT` now.
- **Model** (in Settings, from the user menu at the bottom of the sidebar) picks Opus 5.5, Sonnet 5.5, or Haiku 5.5. Opus is the most capable, Sonnet is balanced, and Haiku is the fastest and cheapest. Only Opus has the automatic safety fallback.
- **Engine** picks who builds new videos. Solo: the chosen model writes the whole thing. Team: it plans the shots, and Haiku agents animate the scenes in parallel. Team is usually faster for longer videos, but scenes can match less closely than with Solo. Follow-up edits and fixes always go to the chosen model alone, so it can see the whole video. If a scene can't be generated, a placeholder fills its slot, and you can ask for a fix.
- **Effort** controls how hard Claude thinks: Fast, Balanced, or Best. Higher effort is slower but more polished.
- Each reply creates a new version. Use **Restore** on any version card to go back to it.
- If the code throws an error, click **Fix with Claude**.
- The **Code** tab shows the code while Claude writes it. You can edit it there and click **Run edits**.
- Your videos are saved in the browser's local storage. A project saved by the earlier version of the app is brought over automatically.

The videos have no audio.
