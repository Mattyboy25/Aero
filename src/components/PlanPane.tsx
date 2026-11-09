import { useEffect, useRef, useState } from "react";
import { IconCopy } from "./Icons";
import { CodeEditor } from "./CodeEditor";

interface Props {
  hidden: boolean;
  /** The plan to show: the live stream while Claude writes it, otherwise the saved plan. */
  source: string;
  streaming: boolean;
  generating: boolean;
  status: string;
  /** The plan differs from the one the version on screen was built from. */
  canBuild: boolean;
  hasVideo: boolean;
  /** Saves the user's edits (called a moment after they stop typing). */
  onChange: (plan: string) => void;
  onBuild: (plan: string) => void;
}

// The Plan tab: Claude writes the plan here before any code, and both of you can edit it.
export function PlanPane({ hidden, source, streaming, generating, status, canBuild, hasVideo, onChange, onBuild }: Props) {
  const [value, setValue] = useState(source);
  const [copied, setCopied] = useState(false);
  const saved = useRef(source);

  // Follow the plan as Claude writes it (or when another version's plan is restored).
  useEffect(() => { setValue(source); saved.current = source; }, [source]);

  // Save edits shortly after typing stops.
  useEffect(() => {
    if (streaming || value === saved.current) return;
    const id = setTimeout(() => { saved.current = value; onChange(value); }, 400);
    return () => clearTimeout(id);
  }, [value, streaming, onChange]);

  const build = () => {
    if (value !== saved.current) { saved.current = value; onChange(value); }
    onBuild(value);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* unavailable */ }
  };
  const dirty = value !== source;
  const buildable = !generating && !!value.trim() && (canBuild || dirty);

  return (
    <div className="pane code-pane plan-pane" hidden={hidden}>
      <div className="code-toolbar">
        <span className={`muted ${streaming ? "shine" : ""}`}>{status}</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={copy} disabled={!value.trim()}><IconCopy width={14} height={14} />{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn small primary" onClick={build} disabled={!buildable}
          title={hasVideo ? "Update the video to match this plan (Ctrl/Cmd + Enter)" : "Write the video from this plan (Ctrl/Cmd + Enter)"}>
          {hasVideo ? "Update video" : "Build video"}
        </button>
      </div>
      <CodeEditor prose value={source} onChange={setValue} onRun={() => { if (buildable) build(); }}
        readOnly={streaming} follow={streaming} label="Plan"
        placeholder="Claude writes a plan here before it writes any code: the look, a beat-by-beat timeline, and how to build it. Edit it, then build the video from it." />
    </div>
  );
}
