import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AudioClip, AudioJob, ClipKind, Overlay, VersionAudio } from "../types";
import type { RuntimeBridge } from "../lib/runtime";
import { createSlosh, type Slosh } from "../lib/slosh";
import { IconPlay } from "./Icons";
import { Timeline, useTimelineZoom, type Segment } from "./Timeline";
import { TransportBar } from "./TransportBar";

interface Props {
  hidden: boolean;
  bridge: RuntimeBridge;
  width: number;
  height: number;
  duration: number;
  fps: number;
  overlay: Overlay;
  onSlosh: (s: Slosh | null) => void;
  runtimeError: string | null;
  onFix: () => void;
  fixDisabled: boolean;
  playing: boolean;
  canPlay: boolean;
  onTogglePlay: () => void;
  onScrub: (t: number) => void;
  /** Scene spans to mark on the timeline (Team mode). */
  segments: Segment[];
  /** Name for the video's clip on the timeline when there are no scenes. */
  clipLabel: string;
  audio?: VersionAudio;
  audioJob?: AudioJob;
  muted: boolean;
  onToggleMute: () => void;
  /** Generates narration and sound for the version on screen. */
  onAddAudio?: () => void;
  showCaptions: boolean;
  onToggleCaptions: () => void;
  narrationMuted: boolean;
  sfxMuted: boolean;
  onToggleLaneMute: (kind: ClipKind) => void;
  onEditCaption: (id: string, patch: { caption: string; start: number }) => void;
  onRevoiceCaption: (id: string, text: string, start: number) => Promise<void>;
}

export function Preview(props: Props) {
  const { hidden, bridge, width, height, overlay, onSlosh, runtimeError, onFix, fixDisabled } = props;
  const iframe = useRef<HTMLIFrameElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const zoomApi = useTimelineZoom();

  useEffect(() => {
    bridge.attach(iframe.current!);
    return () => bridge.detach();
  }, [bridge]);

  useEffect(() => {
    const s = createSlosh(canvas.current!);
    onSlosh(s);
    return () => { s.destroy(); onSlosh(null); };
  }, [onSlosh]);

  return (
    <div className="pane preview-pane" hidden={hidden}>
      <div className="stage">
        <div className="frame" style={{ "--ar": `${width} / ${height}`, "--arn": String(width / height) } as React.CSSProperties}>
          <iframe ref={iframe} src="/runtime.html" sandbox="allow-scripts" title="Video preview" />
          <canvas ref={canvas} className="slosh" hidden aria-hidden="true" />
          {props.showCaptions && !overlay.visible && <CaptionOverlay bridge={bridge} clips={props.audio?.clips} />}
          {overlay.visible && (
            <div className={`overlay ${overlay.busy ? "slosh-mode" : ""} ${overlay.fading ? "fading" : ""}`}>
              <div className="overlay-inner">
                {!overlay.busy && <div className="placeholder-icon" aria-hidden="true"><IconPlay width={22} height={22} /></div>}
                <p role="status">{overlay.text}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {runtimeError && (
        <div className="error-bar" role="alert">
          <span>{runtimeError}</span>
          <button type="button" className="btn small" onClick={onFix} disabled={fixDisabled}>Fix with Claude</button>
        </div>
      )}
      <TransportBar bridge={bridge} duration={props.duration} fps={props.fps} playing={props.playing} canPlay={props.canPlay}
        zoomApi={zoomApi} onTogglePlay={props.onTogglePlay} onScrub={props.onScrub}
        hasAudio={!!props.audio?.clips.length} muted={props.muted} onToggleMute={props.onToggleMute}
        hasCaptions={!!props.audio?.clips.some((c) => c.kind === "narration")} showCaptions={props.showCaptions} onToggleCaptions={props.onToggleCaptions} />
      <Timeline bridge={bridge} duration={props.duration} fps={props.fps} playing={props.playing} canPlay={props.canPlay}
        segments={props.segments} clipLabel={props.clipLabel} zoomApi={zoomApi} onScrub={props.onScrub}
        audio={props.audio} audioJob={props.audioJob} onAddAudio={props.onAddAudio}
        onEditCaption={props.onEditCaption} onRevoiceCaption={props.onRevoiceCaption}
        showCaptions={props.showCaptions} onToggleCaptions={props.onToggleCaptions}
        narrationMuted={props.narrationMuted} sfxMuted={props.sfxMuted} onToggleLaneMute={props.onToggleLaneMute} />
    </div>
  );
}

// The narration line being spoken right now, shown as a caption over the video.
function CaptionOverlay({ bridge, clips }: { bridge: RuntimeBridge; clips?: AudioClip[] }) {
  const t = useSyncExternalStore(bridge.subscribe, bridge.getTime);
  const line = clips?.find((c) => c.kind === "narration" && t >= c.start && t < c.start + c.duration);
  if (!line) return null;
  return <div className="caption-overlay" aria-live="off"><span>{line.caption ?? line.text}</span></div>;
}
