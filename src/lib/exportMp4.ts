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
}

export class ExportCancelled extends Error {}

// Renders every frame exactly, encodes it as H.264 with WebCodecs, and packs it into an MP4.
export async function exportMp4(job: ExportJob): Promise<Blob> {
  if (!("VideoEncoder" in window)) {
    throw new Error("MP4 export needs WebCodecs, which this browser doesn't support. Try a recent Chrome, Edge, or Safari.");
  }
  const { bridge, width: W, height: H, fps, duration } = job;
  const total = Math.round(duration * fps);
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const config = await pickCodec(W, H, fps);
  if (!config) throw new Error("No supported H.264 encoder was found in this browser.");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    fastStart: "in-memory",
  });
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
    return new Blob([muxer.target.buffer], { type: "video/mp4" });
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
