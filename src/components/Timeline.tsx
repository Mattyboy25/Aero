import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import type { RuntimeBridge } from "../lib/runtime";
import { fmtTime } from "../lib/constants";
import { IconPause, IconPlay, IconStepBack, IconStepForward } from "./Icons";

export interface Segment { start: number; end: number; title: string }

interface Props {
  bridge: RuntimeBridge;
  duration: number;
  fps: number;
  playing: boolean;
  canPlay: boolean;
  segments: Segment[];
  onTogglePlay: () => void;
  onScrub: (t: number) => void;
}

const MAJOR_STEPS = [0.5, 1, 2, 5, 10, 15, 30];
const MINOR_COUNT: Record<number, number> = { 0.5: 5, 1: 4, 2: 4, 5: 5, 10: 5, 15: 3, 30: 3 };

function tickLabel(s: number) {
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
}

// Accepts "3.5", "1:02.5", or "f90" (a frame number).
function parseTime(input: string, fps: number): number | null {
  const s = input.trim();
  if (!s) return null;
  const frame = s.match(/^f\s*(\d+)$/i);
  if (frame) return Number(frame[1]) / fps;
  const m = s.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
}

export function Timeline({ bridge, duration, fps, playing, canPlay, segments, onTogglePlay, onScrub }: Props) {
  const time = useSyncExternalStore(bridge.subscribe, bridge.getTime);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null); // time under the pointer
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = track.current!;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = useCallback((t: number) => Math.min(duration, Math.max(0, Math.round(t * fps) / fps)), [duration, fps]);
  const frameOf = (t: number) => Math.round(t * fps);
  const totalFrames = Math.round(duration * fps);

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
    const r = track.current!.getBoundingClientRect();
    return snap(((e.clientX - r.left) / r.width) * duration);
  };
  const onDown = (e: PointerEvent) => {
    if (!canPlay || e.button !== 0) return;
    // Stop the browser from starting a text drag (the "forbidden" cursor) if something is selected.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const t = timeAt(e);
    setHover(t);
    seek(t);
  };
  const onMove = (e: PointerEvent) => {
    const t = timeAt(e);
    setHover(t);
    if (dragging) seek(t);
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

  // Ruler marks: pick a spacing that keeps labels about 64px apart.
  const ticks = useMemo(() => {
    if (!width || !duration) return { majors: [] as number[], minors: [] as number[] };
    const pxPerSec = width / duration;
    const major = MAJOR_STEPS.find((s) => s * pxPerSec >= 64) ?? MAJOR_STEPS[MAJOR_STEPS.length - 1];
    const minorStep = major / (MINOR_COUNT[major] ?? 4);
    const majors: number[] = [];
    const minors: number[] = [];
    for (let i = 0; i * minorStep <= duration + 1e-6; i++) {
      const t = Math.round(i * minorStep * 1000) / 1000;
      if (Math.abs(t / major - Math.round(t / major)) < 1e-6) majors.push(t);
      else if (minorStep * pxPerSec >= 7) minors.push(t);
    }
    return { majors, minors };
  }, [width, duration]);

  const pct = (t: number) => (duration ? (Math.min(duration, Math.max(0, t)) / duration) * 100 : 0);
  const shown = dragging ? time : hover;

  return (
    <div className="transport">
      <div className="transport-buttons">
        <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={!canPlay} aria-label="Previous frame" title="Previous frame (←)">
          <IconStepBack width={16} height={16} />
        </button>
        <button type="button" className="play-btn" onClick={onTogglePlay} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button type="button" className="icon-btn" onClick={() => step(1)} disabled={!canPlay} aria-label="Next frame" title="Next frame (→)">
          <IconStepForward width={16} height={16} />
        </button>
      </div>

      <Timecode time={time} fps={fps} disabled={!canPlay} onCommit={(s) => {
        const t = parseTime(s, fps);
        if (t !== null) onScrub(snap(t));
      }} />

      <div className={`timeline ${canPlay ? "" : "disabled"} ${dragging ? "dragging" : ""}`}>
        <div className="ruler" aria-hidden="true">
          {ticks.minors.map((t) => <span key={`m${t}`} className="tick minor" style={{ left: `${pct(t)}%` }} />)}
          {ticks.majors.map((t) => (
            <span key={`M${t}`} className="tick major" style={{ left: `${pct(t)}%` }}>
              <span className="tick-label" data-edge={t === 0 ? "start" : t >= duration ? "end" : undefined}>{tickLabel(t)}</span>
            </span>
          ))}
        </div>

        <div ref={track} className="track" role="slider" tabIndex={canPlay ? 0 : -1} aria-label="Timeline"
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Number(time.toFixed(2))} aria-valuetext={`${fmtTime(time)}, frame ${frameOf(time)}`}
          aria-disabled={!canPlay} onDragStart={(e) => e.preventDefault()} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => { if (!dragging) setHover(null); }} onKeyDown={onKey}>
          <div className="rail">
            {segments.map((s, i) => (
              <span key={i} className="segment" title={`${s.title} · ${fmtTime(s.start)}–${fmtTime(s.end)}`}
                style={{ left: `${pct(s.start)}%`, width: `${pct(s.end) - pct(s.start)}%` }} />
            ))}
            <div className="played" style={{ width: `${pct(time)}%` }} />
          </div>
          {hover !== null && !dragging && <span className="hover-line" style={{ left: `${pct(hover)}%` }} />}
          <div className="playhead" style={{ left: `${pct(time)}%` }}><span className="playhead-knob" /></div>
          {shown !== null && canPlay && (
            <div className="time-tip" style={{ left: `clamp(34px, ${pct(shown)}%, calc(100% - 34px))` }}>
              <strong>{fmtTime(shown)}</strong>
              <span>frame {frameOf(shown)}</span>
            </div>
          )}
        </div>
      </div>

      <span className="time muted total" title={`${totalFrames} frames at ${fps} fps`}>{fmtTime(duration)}</span>
    </div>
  );
}

// The current time as a button; click it to type an exact time to jump to.
function Timecode({ time, fps, disabled, onCommit }: { time: number; fps: number; disabled: boolean; onCommit: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  // Removing the input can fire a blur, so make sure we only finish once.
  const done = useRef(false);
  useEffect(() => { if (editing) done.current = false; }, [editing]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text);
    setEditing(false);
  };

  if (editing) {
    return (
      <input ref={input} className="timecode editing" value={text} aria-label="Jump to time" placeholder="e.g. 3.5, 1:02, f90"
        onChange={(e) => setText(e.target.value)} onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          if (e.key === "Escape") { e.preventDefault(); finish(false); }
          e.stopPropagation();
        }} />
    );
  }
  return (
    <button type="button" className="timecode" disabled={disabled} title="Click to jump to an exact time"
      onClick={() => { setText(time.toFixed(2).replace(/\.?0+$/, "")); setEditing(true); }}>
      <span className="tc-time">{fmtTime(time)}</span>
      <span className="tc-frame">f{Math.round(time * fps)}</span>
    </button>
  );
}
