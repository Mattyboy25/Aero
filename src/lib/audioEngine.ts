import type { AudioClip, ClipKind } from "../types";
import { getClip } from "./audioStore";

// Plays a version's narration and sound effects in step with the preview.
//
// The video's clock lives in the sandboxed iframe, so rather than drive it, the engine follows it:
// `sync(t, playing)` is called with every time update. If the audio has drifted from `t` (a seek,
// the loop wrapping back to 0, a stall), every clip is rescheduled from `t`.

const DRIFT = 0.12; // seconds of disagreement before resyncing

/** Where a clip's sound is stored. Clips cut from an upload share one copy. */
export const blobIdOf = (c: AudioClip) => c.sourceId ?? c.id;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private lanes: Record<ClipKind, GainNode> | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private clips: AudioClip[] = [];
  private duration = 0;
  private sources: AudioBufferSourceNode[] = [];
  private anchor: { ctxTime: number; t: number } | null = null;
  private loadSeq = 0;
  private volumes = { narration: 0.9, sfx: 0.6, muted: false };

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.lanes = { narration: this.ctx.createGain(), sfx: this.ctx.createGain() };
      this.lanes.narration.connect(this.master);
      this.lanes.sfx.connect(this.master);
      this.applyVolumes();
    }
    return this.ctx;
  }

  /** Decodes a clip's audio. Also used while generating, to measure each clip's length. */
  async decode(blob: Blob): Promise<AudioBuffer> {
    return this.context().decodeAudioData(await blob.arrayBuffer());
  }

  /** Swaps in a new set of clips (or none). Resolves once they're decoded and ready to play. */
  async setClips(clips: AudioClip[], duration: number) {
    const seq = ++this.loadSeq;
    this.stop();
    this.clips = [];
    this.duration = duration;
    const ready: AudioClip[] = [];
    await Promise.all(clips.map(async (c) => {
      if (await this.bufferFor(blobIdOf(c))) ready.push(c);
    }));
    if (seq !== this.loadSeq) return; // a newer set arrived meanwhile
    this.clips = ready;
    // Drop buffers nothing refers to any more.
    const keep = new Set(ready.map(blobIdOf));
    for (const id of this.buffers.keys()) if (!keep.has(id)) this.buffers.delete(id);
  }

  // Many clips can share one recording; decode it once.
  private bufferFor(id: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(id);
    if (have) return Promise.resolve(have);
    let job = this.decoding.get(id);
    if (!job) {
      job = (async () => {
        const blob = await getClip(id);
        if (!blob) return null;
        try { const buf = await this.decode(blob); this.buffers.set(id, buf); return buf; } catch { return null; }
      })().finally(() => this.decoding.delete(id));
      this.decoding.set(id, job);
    }
    return job;
  }

  /** Adds a freshly generated buffer so it doesn't need decoding again. */
  remember(id: string, buffer: AudioBuffer) { this.buffers.set(id, buffer); }

  setVolumes(v: { narration: number; sfx: number; muted: boolean }) {
    this.volumes = v;
    this.applyVolumes();
  }
  private applyVolumes() {
    if (!this.lanes || !this.master || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.lanes.narration.gain.setTargetAtTime(this.volumes.narration, now, 0.02);
    this.lanes.sfx.gain.setTargetAtTime(this.volumes.sfx, now, 0.02);
    this.master.gain.setTargetAtTime(this.volumes.muted ? 0 : 1, now, 0.02);
  }

  get hasClips() { return this.clips.length > 0; }

  /** Call from a click: browsers only let audio start after a user gesture. */
  unlock() {
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
  }

  sync(t: number, playing: boolean) {
    if (!playing || !this.clips.length) { this.stop(); return; }
    const ctx = this.ctx;
    if (this.anchor && ctx) {
      const expected = this.anchor.t + (ctx.currentTime - this.anchor.ctxTime);
      if (Math.abs(expected - t) < DRIFT) return;
    }
    this.start(t);
  }

  private start(t: number) {
    this.stop();
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime + 0.02;
    const endAt = now + Math.max(0, this.duration - t);
    for (const c of this.clips) {
      const buf = this.buffers.get(blobIdOf(c));
      // A slice of an upload plays for its own length; any other clip plays all of its sound.
      const len = c.sourceId ? c.duration : buf?.duration ?? 0;
      if (!buf || c.start + len <= t || c.start >= this.duration) continue;
      const off = c.offset ?? 0;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = c.volume;
      src.connect(gain).connect(this.lanes![c.kind]);
      if (c.start >= t) src.start(now + (c.start - t), off, c.sourceId ? len : undefined);
      else src.start(now, off + (t - c.start), c.sourceId ? len - (t - c.start) : undefined);
      src.stop(endAt);
      this.sources.push(src);
    }
    this.anchor = { ctxTime: now, t };
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.sources = [];
    this.anchor = null;
  }
}

/** Mixes clips into one stereo track for export, at the lane volumes the user set. */
export async function mixdown(
  clips: AudioClip[], duration: number, volumes: { narration: number; sfx: number },
  decode: (blob: Blob) => Promise<AudioBuffer>,
): Promise<AudioBuffer | null> {
  const sampleRate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  let any = false;
  const decoded = new Map<string, AudioBuffer | null>();
  for (const c of clips) {
    const id = blobIdOf(c);
    if (!decoded.has(id)) {
      const blob = await getClip(id);
      let buf: AudioBuffer | null = null;
      if (blob) { try { buf = await decode(blob); } catch { /* skip this clip */ } }
      decoded.set(id, buf);
    }
    const buf = decoded.get(id);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = c.volume * volumes[c.kind];
    src.connect(g).connect(ctx.destination);
    if (c.sourceId) src.start(c.start, c.offset ?? 0, c.duration);
    else src.start(c.start);
    any = true;
  }
  return any ? ctx.startRendering() : null;
}
