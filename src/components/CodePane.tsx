import { useEffect, useState } from "react";
import { IconCopy } from "./Icons";
import { CodeEditor } from "./CodeEditor";

interface Props {
  hidden: boolean;
  /** The code to show: the live stream while Claude writes, otherwise the current version. */
  source: string;
  currentCode: string;
  status: string;
  streaming: boolean;
  generating: boolean;
  onRun: (code: string) => void;
}

export function CodePane({ hidden, source, currentCode, status, streaming, generating, onRun }: Props) {
  const [value, setValue] = useState(source);
  const [copied, setCopied] = useState(false);

  // The editor mirrors `source`; keep our copy in step so Run and Copy see what's on screen.
  useEffect(() => { setValue(source); }, [source]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable */ }
  };
  const canRun = !generating && !!value.trim() && value !== currentCode;

  return (
    <div className="pane code-pane" hidden={hidden}>
      <div className="code-toolbar">
        <span className="muted">{status}</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={copy}><IconCopy width={14} height={14} />{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn small primary" onClick={() => onRun(value)}
          disabled={!canRun} title="Ctrl/Cmd + Enter">Run edits</button>
      </div>
      <CodeEditor value={source} onChange={setValue} onRun={() => { if (canRun) onRun(value); }}
        readOnly={streaming} follow={streaming} label="Animation code"
        placeholder="Generated code shows up here as Claude writes it." />
    </div>
  );
}
