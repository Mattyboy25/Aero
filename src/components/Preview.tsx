import { useEffect, useRef } from "react";
import type { Overlay } from "../types";
import type { RuntimeBridge } from "../lib/runtime";
import { createSlosh, type Slosh } from "../lib/slosh";
import { IconPlay } from "./Icons";
import { Timeline, type Segment } from "./Timeline";

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
}

export function Preview(props: Props) {
  const { hidden, bridge, width, height, overlay, onSlosh, runtimeError, onFix, fixDisabled } = props;
  const iframe = useRef<HTMLIFrameElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

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
      <Timeline bridge={bridge} duration={props.duration} fps={props.fps} playing={props.playing} canPlay={props.canPlay}
        segments={props.segments} onTogglePlay={props.onTogglePlay} onScrub={props.onScrub} />
    </div>
  );
}
