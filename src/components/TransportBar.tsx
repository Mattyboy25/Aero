import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RuntimeBridge } from "../lib/runtime";
import { fmtTime } from "../lib/constants";
import { IconMinus, IconPause, IconPlay, IconPlus, IconSkipBack, IconSkipForward, IconStepBack, IconStepForward, IconVolume, IconVolumeOff } from "./Icons";
import { MAX_ZOOM, type ZoomApi } from "./Timeline";

// Accepts "3.5", "1:02.5", or "f90" (a frame number).
function parseTime(input: string, fps: number): number | null {
  const s = input.trim();
  if (!s) return null;
  const frame = s.match(/^f\s*(\d+)$/i);
  if (frame) return Number(frame[1]) / fps;
  const m = s.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
}

interface Props {
  bridge: RuntimeBridge;
  duration: number;
  fps: number;
  playing: boolean;
  canPlay: boolean;
  zoomApi: ZoomApi;
  onTogglePlay: () => void;
  onScrub: (t: number) => void;
  hasAudio: boolean;
  muted: boolean;
  onToggleMute: () => void;
  hasCaptions: boolean;
  showCaptions: boolean;
  onToggleCaptions: () => void;
}

// The playback controls that sit right under the video: time, transport buttons, and timeline zoom.
export function TransportBar({ bridge, duration, fps, playing, canPlay, zoomApi, onTogglePlay, onScrub, hasAudio, muted, onToggleMute, hasCaptions, showCaptions, onToggleCaptions }: Props) {
  const time = useSyncExternalStore(bridge.subscribe, bridge.getTime);
  const { zoom, setZoom } = zoomApi;
  const snap = useCallback((t: number) => Math.min(duration, Math.max(0, Math.round(t * fps) / fps)), [duration, fps]);
  const step = (frames: number) => onScrub(snap(time + frames / fps));
  const maxLog = Math.log2(MAX_ZOOM);

  return (
    <div className="tbar">
      <div className="tbar-left">
        <Timecode time={time} fps={fps} disabled={!canPlay} onCommit={(s) => {
          const t = parseTime(s, fps);
          if (t !== null) onScrub(snap(t));
        }} />
        <span className="time muted" title={`${Math.round(duration * fps)} frames at ${fps} fps`}>/ {fmtTime(duration)}</span>
        {hasAudio && (
          <button type="button" className={`icon-btn ${muted ? "" : "on"}`} onClick={onToggleMute} aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute narration and sound" : "Mute narration and sound"}>
            {muted ? <IconVolumeOff width={16} height={16} /> : <IconVolume width={16} height={16} />}
          </button>
        )}
        {hasCaptions && (
          <button type="button" className={`cc-btn ${showCaptions ? "on" : ""}`} onClick={onToggleCaptions} aria-pressed={showCaptions}
            title={showCaptions ? "Hide captions on the preview" : "Show captions on the preview"}>CC</button>
        )}
      </div>

      <div className="tbar-center">
        <button type="button" className="icon-btn" onClick={() => onScrub(0)} disabled={!canPlay} aria-label="Go to start" title="Go to start (Home)">
          <IconSkipBack width={16} height={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={!canPlay} aria-label="Previous frame" title="Previous frame (←)">
          <IconStepBack width={16} height={16} />
        </button>
        <button type="button" className="play-btn" onClick={onTogglePlay} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button type="button" className="icon-btn" onClick={() => step(1)} disabled={!canPlay} aria-label="Next frame" title="Next frame (→)">
          <IconStepForward width={16} height={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => onScrub(duration)} disabled={!canPlay} aria-label="Go to end" title="Go to end (End)">
          <IconSkipForward width={16} height={16} />
        </button>
      </div>

      <div className="tbar-right">
        <button type="button" className="icon-btn" onClick={() => setZoom(zoom / 1.6)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out">
          <IconMinus width={15} height={15} />
        </button>
        <input type="range" className="zoom-range" min={0} max={maxLog} step={0.02} value={Math.log2(zoom)}
          style={{ "--pct": `${(Math.log2(zoom) / maxLog) * 100}%` } as React.CSSProperties}
          onChange={(e) => setZoom(2 ** Number(e.target.value))} aria-label="Timeline zoom" title="Timeline zoom (Ctrl + scroll on the timeline)" />
        <button type="button" className="icon-btn" onClick={() => setZoom(zoom * 1.6)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in">
          <IconPlus width={15} height={15} />
        </button>
        <button type="button" className="btn small ghost zoom-fit" onClick={() => setZoom(1)} disabled={zoom <= 1} title="Fit the whole video in view">
          {zoom <= 1.01 ? "Fit" : `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`}
        </button>
      </div>
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
