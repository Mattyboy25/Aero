import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AssistantTurn, AudioJob, Effort, Settings, Turn, Upload, VersionAudio } from "../types";
import { EFFORT_LABELS, SUGGESTIONS, fmtTime } from "../lib/constants";
import { DEFAULT_UPLOAD_PROMPT } from "../lib/upload";
import { IconArrowUp, IconClose, IconKey, IconPaperclip, IconSettings, IconStop, IconVolume, IconWaveform } from "./Icons";

interface Props {
  turns: Turn[];
  versionCount: number;
  current: number;
  generating: boolean;
  settings: Settings;
  effort: Effort;
  modelName: string;
  onSend: (prompt: string) => void;
  onStop: () => void;
  onRestore: (version: number) => void;
  onSettings: (patch: Partial<Settings>) => void;
  onEffort: (e: Effort) => void;
  onOpenSettings: () => void;
  /** No Anthropic key yet, so nothing can be generated. */
  needsKey: boolean;
  onAddKey: () => void;
  /** Each version's narration/sound, by index. */
  versionAudio: (VersionAudio | undefined)[];
  audioJobs: Record<number, AudioJob>;
  /** Generate narration and sound with each new version. */
  audioAuto: boolean;
  onAudioAuto: (on: boolean) => void;
  onAudioSettings: () => void;
  onAddAudio: (version: number) => void;
  onCancelAudio: (version: number) => void;
  onRemoveAudio: (version: number) => void;
  onDismissAudioError: (version: number) => void;
  /** Narration the user uploaded for this new video, and the progress of reading it. */
  upload?: Upload;
  uploadJob?: { name: string; status: "decoding" | "transcribing" | "error"; error?: string } | null;
  canAttach: boolean;
  hasElevenKey: boolean;
  onAttach: (file: File) => void;
  onRemoveUpload: () => void;
  onVoiceover: (on: boolean) => void;
  captionsOn: boolean;
  onCaptions: (on: boolean) => void;
  onAddElevenKey: () => void;
}

export function Chat(props: Props) {
  const { turns, generating, settings, effort, onSend, onStop, onOpenSettings, needsKey, onAddKey, upload, uploadJob } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const newVideo = props.versionCount === 0;
  const readingUpload = newVideo && !!uploadJob && uploadJob.status !== "error";
  const uploadReady = newVideo && !!upload && !uploadJob;
  const showUpload = newVideo && (!!upload || !!uploadJob);

  // Without an ElevenLabs key there's nothing to transcribe with, so ask for one instead.
  const pickAudio = () => { if (!props.hasElevenKey) props.onAddElevenKey(); else fileInput.current?.click(); };
  const takeFile = (file?: File) => { if (!file) return; if (!props.hasElevenKey) props.onAddElevenKey(); else props.onAttach(file); };
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new content while the user is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = (prompt: string) => {
    stick.current = true;
    onSend(prompt);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (generating) { onStop(); return; }
    const prompt = draft.trim() || (uploadReady ? DEFAULT_UPLOAD_PROMPT : "");
    if (!prompt || readingUpload) return;
    if (needsKey) { onAddKey(); return; }
    setDraft("");
    send(prompt);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside className="chat" aria-label="Chat">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {turns.length === 0 ? (
          <div className="empty">
            <h1>What should we make?</h1>
            <p>Describe a video. Claude writes it as an animation in code, and you can keep refining it with follow-up messages.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={generating} onClick={() => (needsKey ? onAddKey() : send(s))}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t) => t.role === "user" ? (
            <div key={t.id} className="msg user">
              {t.text}
            </div>
          ) : (
            <AssistantMessage key={t.id} turn={t} {...props} />
          ))
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        {needsKey && (
          <div className="key-banner" role="note">
            <IconKey width={16} height={16} />
            <span>Add your Anthropic API key to start generating.</span>
            <button type="button" className="btn small" onClick={onAddKey}>Add key</button>
          </div>
        )}
        <div className={`composer-box ${dragOver ? "drop" : ""}`}
          onDragOver={(e) => { if (props.canAttach && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={(e) => { setDragOver(false); if (!props.canAttach) return; e.preventDefault(); takeFile(e.dataTransfer.files[0]); }}>
          {showUpload && (
            <div className={`upload-chip ${uploadJob?.status === "error" ? "error" : ""}`}>
              <span className="upload-icon" aria-hidden="true">
                {readingUpload ? <span className="spinner" /> : <IconWaveform width={16} height={16} />}
              </span>
              <span className="upload-text">
                <span className="upload-name">{upload?.name ?? uploadJob?.name ?? "Narration"}</span>
                <span className="upload-meta" role="status">
                  {uploadJob
                    ? uploadJob.status === "decoding" ? "Reading the audio…"
                      : uploadJob.status === "transcribing" ? "Transcribing with ElevenLabs…" : uploadJob.error
                    : upload ? `${fmtTime(upload.duration)} · ${upload.lines.length} spoken line${upload.lines.length === 1 ? "" : "s"}` : ""}
                </span>
              </span>
              {uploadReady && upload && (
                <span className="upload-toggles">
                  <button type="button" className={`mini-toggle ${props.captionsOn ? "on" : ""}`} aria-pressed={props.captionsOn}
                    onClick={() => props.onCaptions(!props.captionsOn)}
                    title="Show captions made from your narration. They are also drawn into the exported video.">Captions</button>
                  <button type="button" className={`mini-toggle ${upload.voiceover ? "on" : ""}`} aria-pressed={upload.voiceover}
                    onClick={() => props.onVoiceover(!upload.voiceover)}
                    title="Play your recording as the video's voice over. Off keeps it silent and only uses it for the animation and captions.">Voice over</button>
                </span>
              )}
              <button type="button" className="icon-btn" onClick={props.onRemoveUpload} aria-label="Remove the audio" title="Remove the audio"><IconClose width={15} height={15} /></button>
            </div>
          )}
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={showUpload ? 2 : 3}
            placeholder={uploadReady ? "Describe the look you want, or just press Generate…" : "Describe your video, or ask for a change…"} aria-label="Prompt" />
          <div className="composer-row">
            {props.canAttach && (
              <>
                <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm"
                  onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
                <button type="button" className="composer-attach" onClick={pickAudio} disabled={readingUpload}
                  title="Upload a recording of narration. The video is built around it, with captions and your voice over.">
                  <IconPaperclip width={16} height={16} />
                  <span>{upload ? "Replace audio" : "Audio"}</span>
                </button>
              </>
            )}
            <button type="button" className="composer-gear" onClick={onOpenSettings}
              title="Model, protocol and effort settings">
              <IconSettings width={16} height={16} />
              <span>{props.modelName} · {settings.mode === "team" ? "Team" : "Solo"} · {EFFORT_LABELS[effort]}</span>
            </button>
            <button type="button" className={`composer-audio ${props.audioAuto ? "on" : ""}`} aria-pressed={props.audioAuto}
              onClick={() => props.onAudioAuto(!props.audioAuto)}
              title={props.audioAuto
                ? "Narration and sound effects will be generated with each new version. Click to turn off."
                : "Click to also generate narration and sound effects with each new version. You can add them to any version later."}>
              <IconVolume width={15} height={15} />
              <span>{props.audioAuto ? "Audio on" : "Audio"}</span>
            </button>
            <span className="spacer" />
            <button type="submit" className={`send-btn ${generating ? "stop" : ""}`} disabled={!generating && ((!draft.trim() && !uploadReady) || readingUpload)}
              aria-label={generating ? "Stop" : "Generate"} title={generating ? "Stop" : "Generate (Enter)"}>
              {generating ? <IconStop /> : <IconArrowUp />}
            </button>
          </div>
        </div>
        <div className="hint">Enter to send · Shift+Enter for a new line</div>
      </form>
    </aside>
  );
}

const SCENE_STATUS: Record<string, string> = { waiting: "Waiting", writing: "Writing", retrying: "Retrying", done: "Done", failed: "Failed" };
const PHASE_LABEL: Record<string, string> = { writing: "Planning the video", coding: "Writing animation code", animating: "Haiku agents are animating" };

function AssistantMessage(props: Props & { turn: AssistantTurn }) {
  const { turn, versionCount, current, generating, modelName, onRestore } = props;
  const thinkingNow = !!turn.pending && turn.phase === "thinking";
  const label = turn.phase === "thinking" || !turn.phase
    ? (turn.team ? `${modelName} is planning the shots` : "Thinking")
    : PHASE_LABEL[turn.phase] ?? "Working";

  return (
    <div className="msg assistant">
      {turn.thinking && (
        <details className="thinking" open={thinkingNow}>
          <summary>{thinkingNow ? "Thinking…" : "Thought process"}</summary>
          <div className="thinking-text">{turn.thinking}</div>
        </details>
      )}
      {!!turn.team?.scenes.length && (
        <ol className="scene-list">
          {turn.team.scenes.map((sc, i) => (
            <li key={i} className={`scene-item ${sc.status}`} title={sc.error}>
              <span className="scene-dot" />
              <span className="scene-name">{sc.title}</span>
              <span className="scene-meta">
                {`${sc.start.toFixed(1)}–${sc.end.toFixed(1)}s · `}
                {sc.status === "failed" ? "Failed, placeholder used" : `${SCENE_STATUS[sc.status] ?? sc.status}${sc.lines ? ` · ${sc.lines} lines` : ""}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      {turn.text && <div className="body">{turn.text}</div>}
      {turn.pending && <div className="status"><span className="dot-pulse" /><span>{label}…</span></div>}
      {turn.note && <div className="status">{turn.note}</div>}
      {turn.error && <div className="msg-error">{turn.error}</div>}
      {typeof turn.version === "number" && turn.version < versionCount && (
        <div className={`version-card ${turn.version === current ? "current" : ""}`}>
          <span className="tag">Version {turn.version + 1}</span>
          <span className="spacer" />
          {turn.version === current
            ? <span className="muted">Showing</span>
            : <button type="button" className="btn small" disabled={generating} onClick={() => onRestore(turn.version!)}>Restore</button>}
        </div>
      )}
      {typeof turn.version === "number" && turn.version < versionCount && !turn.pending && (
        <AudioRow version={turn.version} audio={props.versionAudio[turn.version]} job={props.audioJobs[turn.version]} {...props} />
      )}
    </div>
  );
}

// Under each version: its narration and sound, a job in progress, or a button to add them.
function AudioRow({ version, audio, job, onAddAudio, onCancelAudio, onRemoveAudio, onDismissAudioError, onAudioSettings }:
  Props & { version: number; audio?: VersionAudio; job?: AudioJob }) {
  if (job && job.stage !== "error" && job.stage !== "done") {
    const label = job.stage === "planning" ? "Writing the script and sound cues" : `Generating audio · ${job.done} of ${job.total}`;
    return (
      <div className="audio-row busy">
        <span className="dot-pulse" />
        <span className="audio-text">{label}…</span>
        <button type="button" className="btn small ghost" onClick={() => onCancelAudio(version)}>Cancel</button>
      </div>
    );
  }
  return (
    <>
      {job?.stage === "error" && (
        <div className="msg-error audio-error">
          <span>{job.error}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => onDismissAudioError(version)}>×</button>
        </div>
      )}
      {audio?.clips.length ? (
        <div className="audio-row">
          <IconVolume width={15} height={15} />
          <span className="audio-text" title={audio.clips.filter((c) => c.kind === "narration").map((c) => c.text).join(" ")}>
            {summarize(audio)}
          </span>
          <button type="button" className="btn small ghost" onClick={() => onAddAudio(version)} title="Write and generate new audio">Regenerate</button>
          <button type="button" className="btn small ghost" onClick={() => onRemoveAudio(version)} title="Remove this version's audio">Remove</button>
        </div>
      ) : (
        <div className="audio-row">
          <button type="button" className="btn small" onClick={() => onAddAudio(version)}>
            <IconVolume width={14} height={14} />Add narration &amp; sound
          </button>
          <button type="button" className="btn small ghost" onClick={onAudioSettings} title="Voice and sound settings">Settings</button>
        </div>
      )}
    </>
  );
}

function summarize(audio: VersionAudio) {
  const lines = audio.clips.filter((c) => c.kind === "narration").length;
  const sfx = audio.clips.length - lines;
  const parts = [lines && `${lines} narration line${lines > 1 ? "s" : ""}`, sfx && `${sfx} sound effect${sfx > 1 ? "s" : ""}`].filter(Boolean);
  return parts.join(" · ") + (audio.skipped ? ` · ${audio.skipped} skipped` : "");
}
