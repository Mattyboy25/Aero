import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { RuntimeBridge } from "../lib/runtime";
import type { AudioClip, AudioJob, ClipKind, VersionAudio } from "../types";
import { fmtTime } from "../lib/constants";
import { ThumbRenderer } from "../lib/thumbs";
import { IconEye, IconEyeOff, IconVolume, IconVolumeOff } from "./Icons";

export interface Segment { start: number; end: number; title: string }

type Ref<T> = { current: T };
interface Anchor { time: number; px: number }

// ---------- zoom ----------
// Zoom 1 fits the whole video in view; higher values stretch the timeline and scroll sideways.
export const MAX_ZOOM = 40;

export interface ZoomApi {
  zoom: number;
  setZoom: (z: number) => void;
  /** Which moment stays put on screen while the zoom changes. Defaults to the playhead. */
  anchor: Ref<Anchor | null>;
  defaultAnchor: Ref<(() => Anchor) | null>;
}

export function useTimelineZoom(): ZoomApi {
  const [zoom, setZ] = useState(1);
  const zoomRef = useRef(1);
  const anchor = useRef<Anchor | null>(null);
  const defaultAnchor = useRef<(() => Anchor) | null>(null);
  const setZoom = useCallback((z: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(1, z));
    if (Math.abs(next - zoomRef.current) < 1e-4) { anchor.current = null; return; }
    anchor.current ??= defaultAnchor.current?.() ?? null;
    zoomRef.current = next;
    setZ(next);
  }, []);
  return { zoom, setZoom, anchor, defaultAnchor };
}

// ---------- ruler ----------
const MAJOR_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
const MINOR_COUNT: Record<number, number> = { 0.1: 2, 0.2: 4, 0.5: 5, 1: 4, 2: 4, 5: 5, 10: 5, 15: 3, 30: 3, 60: 6 };

function tickLabel(s: number) {
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return `${+s.toFixed(2)}s`;
}

function buildTicks(contentW: number, duration: number, fps: number) {
  const majors: number[] = [];
  const minors: number[] = [];
  if (!contentW || !duration) return { majors, minors };
  const pps = contentW / duration;
  const major = MAJOR_STEPS.find((s) => s * pps >= 72) ?? 60;
  let minorStep = major / (MINOR_COUNT[major] ?? 4);
  // Zoomed in far enough, every frame gets its own tick.
  if (pps / fps >= 9 && major * fps <= 60) minorStep = 1 / fps;
  const count = Math.floor(duration / minorStep + 1e-6);
  for (let i = 0; i <= count; i++) {
    const t = Math.round(i * minorStep * 10000) / 10000;
    if (Math.abs(t / major - Math.round(t / major)) < 1e-4) majors.push(t);
    else if (minorStep * pps >= 5) minors.push(t);
  }
  return { majors, minors };
}

// ---------- component ----------
interface Props {
  bridge: RuntimeBridge;
  /** The program on screen, drawn small along the video track. */
  code: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  playing: boolean;
  canPlay: boolean;
  /** Scene spans (Team mode). Without them, the video is one clip. */
  segments: Segment[];
  clipLabel: string;
  zoomApi: ZoomApi;
  onScrub: (t: number) => void;
  audio?: VersionAudio;
  audioJob?: AudioJob;
  onAddAudio?: () => void;
  onEditCaption?: (id: string, patch: { caption: string; start: number }) => void;
  onRevoiceCaption?: (id: string, text: string, start: number) => Promise<void>;
  showCaptions: boolean;
  onToggleCaptions: () => void;
  narrationMuted: boolean;
  sfxMuted: boolean;
  onToggleLaneMute: (kind: ClipKind) => void;
}

export function Timeline({ bridge, code, width, height, duration, fps, playing, canPlay, segments, clipLabel, zoomApi, onScrub, audio, audioJob, onAddAudio, onEditCaption, onRevoiceCaption,
  showCaptions, onToggleCaptions, narrationMuted, sfxMuted, onToggleLaneMute }: Props) {
  const [editing, setEditing] = useState<{ id: string; rect: DOMRect } | null>(null);
  const time = useSyncExternalStore(bridge.subscribe, bridge.getTime);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const { zoom, setZoom, anchor, defaultAnchor } = zoomApi;
  const contentW = viewW ? Math.max(viewW, viewW * zoom) : 0;

  // A hidden copy of the video that draws the thumbnails on the video track.
  const [thumbs, setThumbs] = useState<ThumbRenderer | null>(null);
  useEffect(() => {
    const r = new ThumbRenderer();
    setThumbs(r);
    return () => { r.destroy(); setThumbs(null); };
  }, []);
  useEffect(() => {
    if (thumbs && code) thumbs.configure({ code, aspect: width / height, duration, fps });
  }, [thumbs, code, width, height, duration, fps]);

  useLayoutEffect(() => {
    const el = scroller.current!;
    setViewW(el.clientWidth);
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = useCallback((t: number) => Math.min(duration, Math.max(0, Math.round(t * fps) / fps)), [duration, fps]);
  const frameOf = (t: number) => Math.round(t * fps);
  const pct = (t: number) => (duration ? (Math.min(duration, Math.max(0, t)) / duration) * 100 : 0);

  // ---- zoom: keep the anchored moment where it was on screen ----
  useEffect(() => {
    defaultAnchor.current = () => {
      const sc = scroller.current!, ct = content.current!;
      const t = bridge.getTime();
      const sr = sc.getBoundingClientRect(), cr = ct.getBoundingClientRect();
      const px = cr.left + (duration ? (t / duration) * cr.width : 0) - sr.left;
      return { time: t, px: Math.min(sc.clientWidth, Math.max(0, px)) };
    };
    return () => { defaultAnchor.current = null; };
  }, [bridge, defaultAnchor, duration]);

  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const sc = scroller.current!, ct = content.current!;
    sc.scrollLeft = (duration ? (a.time / duration) * ct.offsetWidth : 0) - a.px;
  }, [zoom, anchor, duration]);

  // Ctrl/Cmd + wheel zooms at the pointer; a plain wheel scrolls sideways when zoomed in.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const sc = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const cr = content.current!.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        anchor.current = { time: duration ? ((e.clientX - cr.left) / cr.width) * duration : 0, px: e.clientX - sr.left };
        setZoom(zoomRef.current * Math.exp(-e.deltaY * 0.004));
      } else if (zoomRef.current > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [anchor, setZoom, duration]);

  // While playing zoomed in, keep the playhead in view.
  useEffect(() => {
    if (!playing || dragging || zoom <= 1 || !contentW) return;
    const sc = scroller.current!;
    const x = (time / duration) * contentW;
    if (x > sc.scrollLeft + sc.clientWidth - 48 || x < sc.scrollLeft) sc.scrollLeft = x - sc.clientWidth * 0.2;
  }, [time, playing, dragging, zoom, contentW, duration]);

  // ---- scrubbing ----
  // Seeking renders a frame in the iframe, so coalesce pointer events to one seek per screen refresh.
  const pending = useRef<number | null>(null);
  const raf = useRef(0);
  const seek = useCallback((t: number) => {
    pending.current = t;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (pending.current !== null) onScrub(pending.current);
      pending.current = null;
    });
  }, [onScrub]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const timeAt = (e: PointerEvent) => {
    const r = content.current!.getBoundingClientRect();
    return snap(((e.clientX - r.left) / r.width) * duration);
  };
  const onDown = (e: PointerEvent) => {
    if (!canPlay || e.button !== 0) return;
    // Stop the browser from starting a text drag (the "forbidden" cursor) if something is selected.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    scroller.current!.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const t = timeAt(e);
    setHover(t);
    seek(t);
  };
  const onMove = (e: PointerEvent) => {
    const t = timeAt(e);
    setHover(t);
    if (!dragging) return;
    seek(t);
    // Dragging near an edge scrolls the timeline along.
    const sc = scroller.current!;
    const r = sc.getBoundingClientRect();
    if (e.clientX > r.right - 32) sc.scrollLeft += 18;
    else if (e.clientX < r.left + 32) sc.scrollLeft -= 18;
  };
  const onUp = (e: PointerEvent) => {
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const step = (frames: number) => onScrub(snap(time + frames / fps));
  const onKey = (e: KeyboardEvent) => {
    const big = e.shiftKey ? fps : 1;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => step(-big), ArrowRight: () => step(big),
      Home: () => onScrub(0), End: () => onScrub(duration),
    };
    if (keys[e.key] && canPlay) { e.preventDefault(); keys[e.key](); }
  };

  const ticks = useMemo(() => buildTicks(contentW, duration, fps), [contentW, duration, fps]);
  const clips = segments.length ? segments : [{ start: 0, end: duration, title: clipLabel }];
  const badgeLeft = hover === null || !contentW ? 0 : Math.min(contentW - 52, Math.max(52, (hover / duration) * contentW));

  return (
    <div className={`tl ${canPlay ? "" : "disabled"} ${dragging ? "dragging" : ""}`}>
      <div className="tl-gutter">
        <div className="tl-corner" />
        <div className={`tl-label ${showCaptions ? "" : "off"}`}>
          <span>Captions</span>
          <button type="button" className="lane-toggle" onClick={onToggleCaptions} aria-pressed={!showCaptions}
            aria-label={showCaptions ? "Hide captions" : "Show captions"} title={showCaptions ? "Hide captions on the preview" : "Show captions on the preview"}>
            {showCaptions ? <IconEye width={14} height={14} /> : <IconEyeOff width={14} height={14} />}
          </button>
        </div>
        <div className="tl-label video"><span>Video</span></div>
        <div className={`tl-label ${narrationMuted ? "off" : ""}`}>
          <span>Voice</span>
          <button type="button" className="lane-toggle" onClick={() => onToggleLaneMute("narration")} aria-pressed={narrationMuted}
            aria-label={narrationMuted ? "Unmute voice" : "Mute voice"} title={narrationMuted ? "Unmute the voice (playback and export)" : "Mute the voice (playback and export)"}>
            {narrationMuted ? <IconVolumeOff width={14} height={14} /> : <IconVolume width={14} height={14} />}
          </button>
        </div>
        <div className={`tl-label ${sfxMuted ? "off" : ""}`}>
          <span>Sound effects</span>
          <button type="button" className="lane-toggle" onClick={() => onToggleLaneMute("sfx")} aria-pressed={sfxMuted}
            aria-label={sfxMuted ? "Unmute sound effects" : "Mute sound effects"} title={sfxMuted ? "Unmute sound effects (playback and export)" : "Mute sound effects (playback and export)"}>
            {sfxMuted ? <IconVolumeOff width={14} height={14} /> : <IconVolume width={14} height={14} />}
          </button>
        </div>
      </div>

      <div ref={scroller} className="tl-scroll" tabIndex={canPlay ? 0 : -1} role="slider" aria-label="Timeline"
        aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Number(time.toFixed(2))}
        aria-valuetext={`${fmtTime(time)}, frame ${frameOf(time)}`} aria-disabled={!canPlay} onKeyDown={onKey}>
        <div ref={content} className="tl-content" style={{ width: contentW || "100%" }}
          onDragStart={(e) => e.preventDefault()} onPointerDown={onDown} onPointerMove={onMove}
          onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => { if (!dragging) setHover(null); }}>
          <div className="tl-ruler" aria-hidden="true">
            {ticks.minors.map((t) => <span key={`m${t}`} className="tick minor" style={{ left: `${pct(t)}%` }} />)}
            {ticks.majors.map((t) => (
              <span key={`M${t}`} className="tick major" style={{ left: `${pct(t)}%` }}>
                <span className="tick-label" data-edge={t === 0 ? "start" : t >= duration ? "end" : undefined}>{tickLabel(t)}</span>
              </span>
            ))}
            {hover !== null && canPlay && (
              <span className="tl-badge" style={{ left: badgeLeft }}>{fmtTime(hover)} · f{frameOf(hover)}</span>
            )}
          </div>

          <CaptionLane clips={audio?.clips} duration={duration} pct={pct} activeId={editing?.id} off={!showCaptions}
            onOpen={onEditCaption ? (c, rect) => { onScrub(c.start); setEditing({ id: c.id, rect }); } : undefined} />

          <div className="tl-track video">
            {clips.map((c, i) => (
              <div key={i} className={`tl-clip ${thumbs && code ? "film" : ""}`} title={`${c.title} · ${fmtTime(c.start)} to ${fmtTime(c.end)}`}
                style={{ left: `${pct(c.start)}%`, width: `${pct(c.end) - pct(c.start)}%` }}>
                {thumbs && code && contentW > 0 && (
                  <Filmstrip renderer={thumbs} scroller={scroller} start={c.start} end={c.end} duration={duration} fps={fps}
                    contentW={contentW} aspect={width / height} />
                )}
                <span className="clip-title">{c.title}</span>
                <span className="clip-dur">{(c.end - c.start).toFixed(1)}s</span>
              </div>
            ))}
          </div>
          <AudioLane kind="narration" clips={audio?.clips} job={audioJob} duration={duration} pct={pct} onAdd={onAddAudio} off={narrationMuted} />
          <AudioLane kind="sfx" clips={audio?.clips} job={audioJob} duration={duration} pct={pct} onAdd={onAddAudio} off={sfxMuted} />

          {hover !== null && !dragging && canPlay && <span className="tl-hover" style={{ left: `${pct(hover)}%` }} />}
          <div className="tl-playhead" style={{ left: `${pct(time)}%` }}><span className="tl-head" /></div>
        </div>
      </div>

      {editing && onEditCaption && onRevoiceCaption && (() => {
        const clip = audio?.clips.find((c) => c.id === editing.id);
        if (!clip) return null;
        const lines = audio!.clips.filter((c) => c.kind === "narration");
        const next = lines[lines.findIndex((c) => c.id === clip.id) + 1];
        return (
          <CaptionEditor key={clip.id} clip={clip} nextStart={next?.start} duration={duration} fps={fps} rect={editing.rect}
            playhead={() => bridge.getTime()} onClose={() => setEditing(null)}
            onSave={(patch) => { onEditCaption(clip.id, patch); setEditing(null); }}
            onRevoice={async (text, start) => { await onRevoiceCaption(clip.id, text, start); setEditing(null); }} />
        );
      })()}
    </div>
  );
}

// Captions are the narration lines, so each caption spans exactly the time its voice clip plays.
function CaptionLane({ clips, duration, pct, activeId, onOpen, off }: {
  clips?: AudioClip[]; duration: number; pct: (t: number) => number; activeId?: string; off?: boolean;
  onOpen?: (c: AudioClip, rect: DOMRect) => void;
}) {
  const lines = (clips ?? []).filter((c) => c.kind === "narration" && c.start < duration);
  if (!lines.length) {
    return <div className="tl-track dim"><span className="lane-note">No captions · they come from the narration</span></div>;
  }
  return (
    <div className={`tl-track captions ${off ? "off" : ""}`}>
      {lines.map((c, i) => {
        const end = Math.min(duration, c.start + c.duration);
        const overlaps = !!lines[i + 1] && lines[i + 1].start < c.start + c.duration - 0.02;
        const edited = c.caption !== undefined && c.caption !== c.text;
        const problems = [
          overlaps && "Overlaps the next line, so the two voices will talk over each other.",
          c.start + c.duration > duration + 0.05 && "Runs past the end of the video and will be cut off.",
          edited && `The voice still says: "${c.text}". Re-voice this line to match.`,
        ].filter(Boolean);
        return (
          <button key={c.id} type="button"
            className={`tl-caption ${activeId === c.id ? "active" : ""} ${problems.length ? "warn" : ""}`}
            style={{ left: `${pct(c.start)}%`, width: `${Math.max(0.4, pct(end) - pct(c.start))}%` }}
            title={`${fmtTime(c.start)}–${fmtTime(c.start + c.duration)} · ${c.caption ?? c.text}${problems.length ? "\n\n" + problems.join("\n") : ""}\n\nClick to edit`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => onOpen?.(c, e.currentTarget.getBoundingClientRect())} disabled={!onOpen}>
            <span className="caption-text">{c.caption ?? c.text}</span>
          </button>
        );
      })}
    </div>
  );
}

// A small popover for one caption: its text and start time. Moving it moves the voice too.
function CaptionEditor({ clip, nextStart, duration, fps, rect, playhead, onClose, onSave, onRevoice }: {
  clip: AudioClip; nextStart?: number; duration: number; fps: number; rect: DOMRect; playhead: () => number;
  onClose: () => void; onSave: (patch: { caption: string; start: number }) => void; onRevoice: (text: string, start: number) => Promise<void>;
}) {
  const [text, setText] = useState(clip.caption ?? clip.text);
  const [start, setStart] = useState(clip.start.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
    const onDown = (e: globalThis.PointerEvent) => { if (!busy && !box.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [busy, onClose]);

  const startNum = Number(start);
  const validStart = Number.isFinite(startNum) && startNum >= 0 && startNum < duration;
  const s = validStart ? startNum : clip.start;
  const end = s + clip.duration;
  const changedWords = text.trim() !== clip.text.trim();
  const overlaps = nextStart !== undefined && end > nextStart + 0.02 && s < nextStart;
  const pastEnd = end > duration + 0.05;

  const nudge = (frames: number) => setStart(Math.min(duration, Math.max(0, s + frames / fps)).toFixed(2));
  const revoice = async () => {
    setBusy(true);
    setError(null);
    try { await onRevoice(text, s); } catch (err: any) { setError(err?.message || String(err)); setBusy(false); }
  };

  // Open below the caption, kept on screen.
  const width = 340;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  const below = rect.bottom + 8;
  const style: React.CSSProperties = below + 300 > window.innerHeight
    ? { left, width, bottom: window.innerHeight - rect.top + 8 }
    : { left, width, top: below };

  return (
    <div ref={box} className="caption-editor" style={style} role="dialog" aria-label="Edit caption">
      <label className="ce-label" htmlFor="ceText">Caption</label>
      <textarea id="ceText" ref={field} value={text} rows={3} disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (changedWords) void revoice(); else onSave({ caption: text, start: s }); }
        }} />

      <div className="ce-timing">
        <label className="ce-label" htmlFor="ceStart">Starts at</label>
        <div className="ce-time">
          <button type="button" className="icon-btn" onClick={() => nudge(-1)} disabled={busy} aria-label="One frame earlier" title="One frame earlier">‹</button>
          <input id="ceStart" value={start} inputMode="decimal" disabled={busy} aria-invalid={!validStart}
            onChange={(e) => setStart(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <span className="muted">s</span>
          <button type="button" className="icon-btn" onClick={() => nudge(1)} disabled={busy} aria-label="One frame later" title="One frame later">›</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStart(playhead().toFixed(2))} title="Start this line where the playhead is">At playhead</button>
        </div>
        <p className="ce-meta">
          Voice plays {fmtTime(s)} to {fmtTime(end)} ({clip.duration.toFixed(1)}s).
          {overlaps && <span className="ce-warn"> Overlaps the next line at {fmtTime(nextStart!)}.</span>}
          {pastEnd && <span className="ce-warn"> Runs past the end of the video.</span>}
        </p>
      </div>

      {changedWords && (
        <p className="ce-note">The voice says something different. <strong>Re-voice</strong> reads your new caption aloud so they match; its length may change.</p>
      )}
      {error && <p className="ce-error" role="alert">{error}</p>}

      <div className="ce-actions">
        <button type="button" className="btn small ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <span className="spacer" />
        <button type="button" className={`btn small ${changedWords ? "ghost" : "primary"}`} disabled={busy || !validStart || !text.trim()}
          onClick={() => onSave({ caption: text, start: s })} title={changedWords ? "Keep the current voice and only change the caption" : undefined}>
          {changedWords ? "Caption only" : "Save"}
        </button>
        {changedWords && (
          <button type="button" className="btn small primary" disabled={busy || !validStart || !text.trim()} onClick={revoice}>
            {busy ? "Re-voicing…" : "Save & re-voice"}
          </button>
        )}
      </div>
    </div>
  );
}

// One audio lane. Clips stack into rows when they overlap, so short effects stay visible.
function AudioLane({ kind, clips, job, duration, pct, onAdd, off }: {
  kind: ClipKind; clips?: AudioClip[]; job?: AudioJob; duration: number; pct: (t: number) => number; onAdd?: () => void; off?: boolean;
}) {
  const mine = (clips ?? []).filter((c) => c.kind === kind && c.start < duration);
  const busy = job && (job.stage === "planning" || job.stage === "generating");
  if (!mine.length) {
    const name = kind === "narration" ? "No narration" : "No sound effects";
    return (
      <div className={`tl-track dim ${busy ? "generating" : ""}`}>
        <span className="lane-note">
          {busy ? (job.stage === "planning" ? "Planning audio…" : `Generating audio · ${job.done} of ${job.total}`) : name}
          {!busy && onAdd && !clips?.length && (
            <button type="button" className="lane-add" onPointerDown={(e) => e.stopPropagation()} onClick={onAdd}>Add narration &amp; sound</button>
          )}
        </span>
      </div>
    );
  }
  // Greedy row packing: put each clip in the first row where it doesn't overlap.
  const rowEnds: number[] = [];
  const placed = mine.map((c) => {
    const end = Math.min(duration, c.start + c.duration);
    let row = rowEnds.findIndex((e) => e <= c.start + 0.01);
    if (row === -1) { row = rowEnds.length; rowEnds.push(end); } else rowEnds[row] = end;
    return { c, end, row };
  });
  const rows = Math.min(2, rowEnds.length);
  return (
    <div className={`tl-track audio ${kind} ${off ? "off" : ""} ${busy ? "dim generating" : ""}`} style={{ "--rows": rows } as React.CSSProperties}>
      {placed.map(({ c, end, row }) => (
        <div key={c.id} className="tl-aclip" title={`${fmtTime(c.start)} · ${c.text}`}
          style={{ left: `${pct(c.start)}%`, width: `${Math.max(0.4, pct(end) - pct(c.start))}%`, "--row": Math.min(row, rows - 1) } as React.CSSProperties}>
          <span className="aclip-text">{c.text}</span>
        </div>
      ))}
    </div>
  );
}

// The frames of one clip, laid end to end like Premiere's filmstrip. Only the part of the clip you
// can see (plus a little either side) is drawn, so zooming in far never needs a giant canvas.
const Filmstrip = memo(function Filmstrip({ renderer, scroller, start, end, duration, fps, contentW, aspect }: {
  renderer: ThumbRenderer; scroller: RefObject<HTMLDivElement | null>; start: number; end: number;
  duration: number; fps: number; contentW: number; aspect: number;
}) {
  useSyncExternalStore(renderer.subscribe, renderer.getVersion); // redraw as frames arrive
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(46);
  const [range, setRange] = useState({ from: 0, to: 0 });

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setH(el.clientHeight || 46);
    const ro = new ResizeObserver(() => setH(el.clientHeight || 46));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which part of the timeline is on screen.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let raf = 0;
    const update = () => { raf = 0; setRange({ from: sc.scrollLeft, to: sc.scrollLeft + sc.clientWidth }); };
    const queue = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    sc.addEventListener("scroll", queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(sc);
    return () => { cancelAnimationFrame(raf); sc.removeEventListener("scroll", queue); ro.disconnect(); };
  }, [scroller, contentW]);

  const clipDur = Math.max(0.001, end - start);
  const clipPx = (clipDur / duration) * contentW;
  const clipLeft = (start / duration) * contentW;
  const tileW = Math.max(12, h * aspect);

  // The tiles in view, and the moment each one shows (its middle).
  const margin = tileW * 2;
  const a = Math.max(0, range.from - clipLeft - margin);
  const b = Math.min(clipPx, range.to - clipLeft + margin);
  const k0 = Math.floor(a / tileW);
  const k1 = b > a ? Math.ceil(b / tileW) : k0;
  const last = Math.max(0, Math.round(duration * fps) - 1);
  const frames: number[] = [];
  for (let k = k0; k < k1; k++) {
    const t = start + Math.min(clipDur, ((k + 0.5) * tileW / clipPx) * clipDur);
    frames.push(Math.min(last, renderer.frameOf(t)));
  }

  // Ask for what's missing, starting from the middle of the view so the part you're looking at fills first.
  const key = frames.join(",");
  const epoch = renderer.epoch;
  useEffect(() => {
    const mid = (range.from + range.to) / 2;
    const order = frames
      .map((f, i) => ({ f, d: Math.abs(clipLeft + (k0 + i + 0.5) * tileW - mid) }))
      .sort((x, y) => x.d - y.d)
      .map((x) => x.f);
    const id = setTimeout(() => renderer.request(order), 80);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, key, epoch]);

  // Draw whatever is rendered. A tile still waiting borrows the nearest frame, so nothing flashes empty.
  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const px = (n: number) => Math.round(n * dpr);
    cv.width = Math.max(1, px(frames.length * tileW));
    cv.height = Math.max(1, px(h));
    cv.style.left = `${k0 * tileW}px`;
    cv.style.width = `${frames.length * tileW}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    frames.forEach((f, i) => {
      const bm = renderer.nearest(f);
      if (bm) ctx.drawImage(bm, px(i * tileW), 0, px((i + 1) * tileW) - px(i * tileW), cv.height);
    });
  });

  return (
    <div ref={host} className="film-strip" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
});
