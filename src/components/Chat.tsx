import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AssistantTurn, Effort, Engine, Settings, Turn } from "../types";
import { EFFORT_LABELS, SUGGESTIONS } from "../lib/constants";
import { IconArrowUp, IconStop } from "./Icons";
import { Select } from "./Select";

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
}

export function Chat(props: Props) {
  const { turns, generating, settings, effort, onSend, onStop, onSettings, onEffort } = props;
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
    const prompt = draft.trim();
    if (!prompt) return;
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
                <button key={s} type="button" disabled={generating} onClick={() => send(s)}>{s}</button>
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
        <div className="composer-box">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={3}
            placeholder="Describe your video, or ask for a change…" aria-label="Prompt" />
          <div className="composer-row">
            <Select<Engine> value={settings.mode} onChange={(mode) => onSettings({ mode })} label="Engine"
              title="Solo: your chosen model writes the whole video. Team: it plans the shots and Haiku agents animate each scene in parallel. Edits always go to your chosen model. Change the model in Settings."
              options={[{ value: "solo", label: "Solo" }, { value: "team", label: "Team" }]} />
            <Select<Effort> value={effort} onChange={onEffort} label="Effort"
              title="How hard Claude thinks. Higher is slower but more polished."
              options={(Object.keys(EFFORT_LABELS) as Effort[]).map((v) => ({ value: v, label: EFFORT_LABELS[v] }))} />
            <span className="spacer" />
            <button type="submit" className={`send-btn ${generating ? "stop" : ""}`} disabled={!generating && !draft.trim()}
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

function AssistantMessage({ turn, versionCount, current, generating, modelName, onRestore }: Props & { turn: AssistantTurn }) {
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
    </div>
  );
}
