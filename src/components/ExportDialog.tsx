import { useEffect, useRef } from "react";
import { IconDownload } from "./Icons";

export interface ExportState {
  status: string;
  progress: number; // 0..1
  running: boolean;
  url?: string;
  filename?: string;
}

interface Props {
  state: ExportState;
  onCancel: () => void;
  onClose: () => void;
}

export function ExportDialog({ state, onCancel, onClose }: Props) {
  const download = useRef<HTMLAnchorElement>(null);

  // Start the download as soon as the file is ready; the button stays for a second try.
  useEffect(() => {
    if (state.url) download.current?.click();
  }, [state.url]);

  return (
    <div className="export-dialog">
      <div className="export-card" role="dialog" aria-modal="true" aria-labelledby="exportTitle">
        <h2 id="exportTitle">{state.running ? "Exporting video" : state.url ? "Export complete" : "Export"}</h2>
        <p className="muted">{state.status}</p>
        <div className="bar"><div className="bar-fill" style={{ width: `${state.progress * 100}%` }} /></div>
        <div className="export-actions">
          <button type="button" className="btn ghost" onClick={state.running ? onCancel : onClose}>
            {state.running ? "Cancel" : "Close"}
          </button>
          {state.url && (
            <a ref={download} className="btn primary" href={state.url} download={state.filename}>
              <IconDownload width={16} height={16} />Download MP4
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
