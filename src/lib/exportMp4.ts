import type { RuntimeBridge } from "./runtime";

export interface ExportJob {
  bridge: RuntimeBridge;
  width: number;
  height: number;
  fps: number;
  duration: number;
  onProgress: (done: number, total: number) => void;
  isCancelled: () => boolean;
  lastError: () => string | null;
  /** A finished mix to put in the file as its soundtrack. */
  audio?: AudioBuffer | null;
}

export interface ExportResult {
  blob: Blob;
  /** Set when there was audio but this browser couldn't encode it. */
  audioSkipped?: boolean;
}

export class ExportCancelled extends Error {}

// Renders every frame exactly, encodes it as H.264 with WebCodecs, and packs it into an MP4.
export async function exportMp4(job: ExportJob): Promise<ExportResult> {
  if (!("VideoEncoder" in window)) {
    throw new Error("MP4 export needs WebCodecs, which this browser doesn't support. Try a recent Chrome, Edge, or Safari.");
  }
  const { bridge, width: W, height: H, fps, duration } = job;
  const total = Math.round(duration * fps);
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const config = await pickCodec(W, H, fps);
  if (!config) throw new Error("No supported H.264 encoder was found in this browser.");

  const audioConfig = job.audio ? await pickAudioCodec(job.audio) : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    audio: audioConfig ? { codec: audioConfig.muxCodec, numberOfChannels: audioConfig.config.numberOfChannels, sampleRate: audioConfig.config.sampleRate } : undefined,
    fastStart: "in-memory",
  });
  if (job.audio && audioConfig) await encodeAudio(job.audio, audioConfig.config, muxer);
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  try {
    encoder.configure(config);
    const frameDur = 1e6 / fps;
    for (let i = 0; i < total; i++) {
      if (job.isCancelled()) throw new ExportCancelled("cancelled");
      if (encodeError) throw encodeError;
      const bitmap = await bridge.requestFrame(i / fps);
      if (!bitmap) throw new Error(job.lastError() || `Frame ${i} failed to render.`);
      const frame = new VideoFrame(bitmap, { timestamp: Math.round(i * frameDur), duration: Math.round(frameDur) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      bitmap.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      if (i % 3 === 0 || i === total - 1) job.onProgress(i + 1, total);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    encoder.close();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), audioSkipped: !!job.audio && !audioConfig };
  } catch (err) {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* already closed */ }
    throw err;
  }
}

async function pickCodec(width: number, height: number, framerate: number): Promise<VideoEncoderConfig | null> {
  const codecs = ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42e01f"];
  const bitrate = Math.round(width * height * framerate * 0.15);
  for (const codec of codecs) {
    const config: VideoEncoderConfig = { codec, width, height, framerate, bitrate, avc: { format: "avc" } };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch { /* try next */ }
  }
  return null;
}

type MuxAudioCodec = "aac" | "opus";

async function pickAudioCodec(buf: AudioBuffer): Promise<{ config: AudioEncoderConfig; muxCodec: MuxAudioCodec } | null> {
  if (!("AudioEncoder" in window)) return null;
  const base = { sampleRate: buf.sampleRate, numberOfChannels: buf.numberOfChannels, bitrate: 160000 };
  const options: { config: AudioEncoderConfig; muxCodec: MuxAudioCodec }[] = [
    { config: { ...base, codec: "mp4a.40.2" }, muxCodec: "aac" },
    { config: { ...base, codec: "opus" }, muxCodec: "opus" },
  ];
  for (const o of options) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported(o.config);
      if (supported) return o;
    } catch { /* try next */ }
  }
  return null;
}

// Encodes the whole mix up front, in 0.1 s slices, before any video frames are rendered.
async function encodeAudio(buf: AudioBuffer, config: AudioEncoderConfig, muxer: { addAudioChunk: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void }) {
  let error: unknown = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { error = e; } });
  encoder.configure(config);
  const { sampleRate, numberOfChannels: ch, length } = buf;
  const channels = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  const slice = Math.round(sampleRate / 10);
  for (let at = 0; at < length; at += slice) {
    const n = Math.min(slice, length - at);
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(channels[c].subarray(at, at + n), c * n);
    const frame = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((at / sampleRate) * 1e6), data });
    encoder.encode(frame);
    frame.close();
    if (error) throw error;
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
}
