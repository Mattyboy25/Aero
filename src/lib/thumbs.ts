import { RuntimeBridge } from "./runtime";

// Frames for the timeline's video track, like the thumbnails Premiere shows on a clip.
//
// Asking the preview for a frame would pause it and change what's on screen, so thumbnails come
// from a second, hidden copy of the runtime. It runs the same code at a small size (the code sizes
// everything from W and H, so it looks the same, just cheaper), renders one requested frame at a
// time, and keeps what it has rendered so zooming and scrolling reuse it.

const THUMB_H = 96; // tall enough for a 46px-high clip on a 2x screen
const MAX_CACHED = 500;

export interface ThumbConfig { code: string; aspect: number; duration: number; fps: number }

export class ThumbRenderer {
  private bridge = new RuntimeBridge();
  private iframe: HTMLIFrameElement;
  private booted = false;
  private cfg: ThumbConfig | null = null;
  private key = "";
  private loaded = false;
  /** Rendered frames by frame number, oldest first. */
  private frames = new Map<number, ImageBitmap>();
  private wanted: number[] = [];
  private running = false;
  private gen = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyQueued = 0;

  constructor() {
    const f = document.createElement("iframe");
    f.src = "/runtime.html";
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.title = "Timeline thumbnails";
    Object.assign(f.style, { position: "fixed", left: "-10000px", top: "0", width: "320px", height: "180px", visibility: "hidden", pointerEvents: "none", border: "0" });
    document.body.appendChild(f);
    this.iframe = f;
    this.bridge.handlers = {
      onBooted: () => { this.booted = true; this.load(); },
      onReady: () => {},
      onError: () => {}, // a program that fails here just gets no thumbnails
    };
    this.bridge.attach(f);
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  /** Changes whenever the video does, which empties the cache. */
  get epoch() { return this.gen; }

  private notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = requestAnimationFrame(() => {
      this.notifyQueued = 0;
      this.version++;
      this.listeners.forEach((fn) => fn());
    });
  }

  /** Points the renderer at a video. Changing the code, shape or length starts over. */
  configure(cfg: ThumbConfig) {
    const key = `${cfg.aspect.toFixed(4)}|${cfg.duration}|${cfg.fps}|${cfg.code}`;
    if (key === this.key) return;
    this.key = key;
    this.cfg = cfg;
    this.gen++;
    this.wanted = [];
    this.loaded = false;
    this.frames.forEach((b) => b.close());
    this.frames.clear();
    this.notify();
    if (this.booted) this.load();
  }

  private load() {
    const c = this.cfg;
    if (!c || !this.booted) return;
    const H = THUMB_H;
    const W = Math.max(32, Math.min(512, Math.round(H * c.aspect)));
    this.bridge.load({ code: c.code, W, H, DURATION: c.duration, FPS: c.fps, t: 0, autoplay: false });
    this.loaded = true;
    void this.run();
  }

  frameOf(t: number) { return Math.max(0, Math.round(t * (this.cfg?.fps ?? 30))); }

  /** The rendered frame closest to `frame`, or undefined when nothing has rendered yet. */
  nearest(frame: number): ImageBitmap | undefined {
    const exact = this.frames.get(frame);
    if (exact) return exact;
    let best: number | null = null;
    for (const f of this.frames.keys()) if (best === null || Math.abs(f - frame) < Math.abs(best - frame)) best = f;
    return best === null ? undefined : this.frames.get(best);
  }

  has(frame: number) { return this.frames.has(frame); }

  /** Asks for these frames, in this order. Anything asked for earlier and not yet rendered is dropped. */
  request(frames: number[]) {
    this.wanted = [...new Set(frames)].filter((f) => !this.frames.has(f));
    void this.run();
  }

  private async run() {
    if (this.running || !this.loaded) return;
    this.running = true;
    try {
      while (this.wanted.length && this.cfg) {
        const frame = this.wanted.shift()!;
        if (this.frames.has(frame)) continue;
        const gen = this.gen;
        const bitmap = await this.bridge.requestFrame(frame / this.cfg.fps);
        if (!bitmap) continue;
        if (gen !== this.gen) { bitmap.close(); continue; } // the video changed while this rendered
        this.frames.set(frame, bitmap);
        if (this.frames.size > MAX_CACHED) {
          const oldest = this.frames.keys().next().value as number;
          this.frames.get(oldest)?.close();
          this.frames.delete(oldest);
        }
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }

  destroy() {
    this.gen++;
    this.wanted = [];
    cancelAnimationFrame(this.notifyQueued);
    this.bridge.detach();
    this.iframe.remove();
    this.frames.forEach((b) => b.close());
    this.frames.clear();
    this.listeners.clear();
  }
}
