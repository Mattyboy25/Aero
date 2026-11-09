// Talks to public/runtime.html, the sandboxed iframe that runs the generated code.

export interface LoadOptions {
  code: string;
  W: number;
  H: number;
  DURATION: number;
  FPS: number;
  t: number;
  autoplay: boolean;
}

interface Handlers {
  onBooted?: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

export class RuntimeBridge {
  booted = false;
  handlers: Handlers = {};
  private iframe: HTMLIFrameElement | null = null;
  private time = 0;
  private listeners = new Set<() => void>();
  private pending = new Map<number, (bitmap: ImageBitmap | null) => void>();
  private seq = 0;

  attach(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    window.addEventListener("message", this.onMessage);
    // The iframe may have loaded before we started listening; ask it to announce itself.
    iframe.contentWindow?.postMessage({ type: "hello" }, "*");
  }

  detach() {
    window.removeEventListener("message", this.onMessage);
    this.iframe = null;
  }

  private post(msg: unknown) {
    if (this.booted) this.iframe?.contentWindow?.postMessage(msg, "*");
  }

  load(opts: LoadOptions) {
    this.setTime(opts.t);
    this.post({ type: "load", ...opts });
  }
  play() { this.post({ type: "play" }); }
  pause() { this.post({ type: "pause" }); }
  seek(t: number) {
    this.setTime(t);
    this.post({ type: "seek", t });
  }

  requestFrame(t: number): Promise<ImageBitmap | null> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.post({ type: "frame", t, id });
    });
  }

  // Playback time is kept outside React state so 60 updates a second don't re-render the app.
  getTime = () => this.time;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  private setTime(t: number) {
    this.time = t;
    this.listeners.forEach((fn) => fn());
  }

  private onMessage = (e: MessageEvent) => {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const m = e.data || {};
    switch (m.type) {
      case "booted":
        if (this.booted) break;
        this.booted = true;
        this.handlers.onBooted?.();
        break;
      case "ready":
        this.handlers.onReady?.();
        break;
      case "time":
        this.setTime(m.t);
        break;
      case "error":
        this.handlers.onError?.(m.message);
        break;
      case "frame": {
        const resolve = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve?.(m.failed ? null : m.bitmap);
        break;
      }
    }
  };
}
