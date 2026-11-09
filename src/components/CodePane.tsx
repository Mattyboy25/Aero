import { useEffect, useRef, useState } from "react";
import { IconCopy } from "./Icons";

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
  const editor = useRef<HTMLTextAreaElement>(null);

  // Follow new code unless the user is typing in the editor.
  useEffect(() => {
    if (document.activeElement === editor.current) return;
    setValue(source);
    if (streaming && editor.current) editor.current.scrollTop = editor.current.scrollHeight;
  }, [source, streaming]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { editor.current?.select(); }
  };

  return (
    <div className="pane code-pane" hidden={hidden}>
      <div className="code-toolbar">
        <span className="muted">{status}</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={copy}><IconCopy width={14} height={14} />{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn small primary" onClick={() => onRun(value)}
          disabled={generating || !value.trim() || value === currentCode}>Run edits</button>
      </div>
      <textarea ref={editor} className="code-editor" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder="Generated code shows up here as Claude writes it." aria-label="Animation code" />
    </div>
  );
}
