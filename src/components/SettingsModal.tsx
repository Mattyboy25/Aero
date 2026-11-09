import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Accent, AnimationStyle, Effort, Engine, ModelKey, Theme } from "../types";
import { ACCENTS, ANIMATION_STYLES, EFFORT_LABELS, MODEL_INFO, MODEL_KEYS } from "../lib/constants";
import type { User } from "../lib/user";
import { Avatar, ThemeSwitch } from "./UserMenu";
import { IconAnimation, IconClose, IconPause, IconPlay, IconDatabase, IconEye, IconEyeOff, IconKey, IconLock, IconMic, IconSparkle, IconSun, IconUser, IconVolume } from "./Icons";
import { checkKey, KEY_HEADERS, maskKey, type ApiKeys, type Provider } from "../lib/keys";
import { DEFAULT_VOICE, type AudioPrefs } from "../lib/audioPrefs";
import { Select } from "./Select";

const TABS = [
  { id: "account", label: "Account", Icon: IconUser },
  { id: "model", label: "Model", Icon: IconSparkle },
  { id: "animation", label: "Animation", Icon: IconAnimation },
  { id: "api", label: "API", Icon: IconKey },
  { id: "appearance", label: "Appearance", Icon: IconSun },
  { id: "voice", label: "Voice", Icon: IconMic },
  { id: "sound", label: "Sound effects", Icon: IconVolume },
  { id: "storage", label: "Storage", Icon: IconDatabase },
] as const;
export type SettingsTab = typeof TABS[number]["id"];
type TabId = SettingsTab;

const ENGINES: { value: Engine; label: string }[] = [{ value: "solo", label: "Solo" }, { value: "team", label: "Team" }];
const EFFORTS = Object.keys(EFFORT_LABELS) as Effort[];

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented theme-switch" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Switch({ label, checked = false, disabled, onChange }: { label: string; checked?: boolean; disabled?: boolean; onChange?: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`switch ${checked ? "on" : ""}`} onClick={() => onChange?.(!checked)}><span className="switch-thumb" /></button>
  );
}

function Volume({ label, value, disabled, onChange }: { label: string; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <div className="range-wrap">
      <input type="range" className="set-range" min={0} max={100} value={value} disabled={disabled} aria-label={label}
        style={{ "--pct": `${value}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="range-val">{value}%</span>
    </div>
  );
}

interface Voice { id: string; name: string; desc: string; preview: string | null }

// The voices on the user's ElevenLabs account, loaded once the Voice page opens.
function useVoices(key: string | null) {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetch("/api/audio/voices", { headers: { [KEY_HEADERS.elevenlabs]: key } })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || "Couldn't load voices."))))
      .then((d) => { if (alive) setVoices(d.voices); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [key]);
  return { voices, error };
}

function VoicePreview({ url }: { url: string | null }) {
  const [audio] = useState(() => new Audio());
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const stop = () => setPlaying(false);
    audio.addEventListener("ended", stop);
    audio.addEventListener("pause", stop);
    return () => { audio.pause(); audio.removeEventListener("ended", stop); audio.removeEventListener("pause", stop); };
  }, [audio]);
  useEffect(() => { audio.pause(); }, [audio, url]);
  if (!url) return null;
  const toggle = () => {
    if (playing) { audio.pause(); return; }
    audio.src = url;
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={playing ? "Stop preview" : "Play a sample of this voice"} title={playing ? "Stop" : "Preview voice"}>
      {playing ? <IconPause width={15} height={15} /> : <IconPlay width={14} height={14} />}
    </button>
  );
}

function AudioWhen({ prefs, onPrefs }: { prefs: AudioPrefs; onPrefs: (p: Partial<AudioPrefs>) => void }) {
  return (
    <div className="set-row set-gap">
      <div className="set-info">
        <span className="set-title">Generate with new versions</span>
        <span className="set-desc">Add narration and sound automatically after Claude finishes each version. When this is off, use "Add narration &amp; sound" on any version in the chat. Same as the Audio button by the prompt box.</span>
      </div>
      <Switch label="Generate with new versions" checked={prefs.auto} onChange={(auto) => onPrefs({ auto })} />
    </div>
  );
}

interface KeyInfo { provider: Provider; title: string; blurb: string; placeholder: string; link: string; linkLabel: string }
const KEY_INFO: KeyInfo[] = [
  { provider: "anthropic", title: "Anthropic API key", blurb: "Required to generate videos with Claude.",
    placeholder: "sk-ant-…", link: "https://platform.claude.com/settings/keys", linkLabel: "Get a key from the Claude Console" },
  { provider: "elevenlabs", title: "ElevenLabs API key", blurb: "Required for the Voice and Sound effects settings.",
    placeholder: "sk_…", link: "https://elevenlabs.io/app/settings/api-keys", linkLabel: "Get a key from ElevenLabs" },
];

type Note = { tone: "ok" | "warn" | "error"; text: string };

// One provider's key: a masked field to enter it, then a "connected" row once saved.
function KeyCard({ info, apiKeys }: { info: KeyInfo; apiKeys: ApiKeys }) {
  const { provider } = info;
  const saved = apiKeys.keys[provider];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const entering = !saved || editing;

  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setNote(null);
    const result = await checkKey(provider, value);
    if (result.status === "invalid") {
      setNote({ tone: "error", text: result.message });
      setBusy(false);
      return;
    }
    await apiKeys.save(provider, value);
    setText("");
    setShow(false);
    setEditing(false);
    setNote({ tone: result.status === "valid" ? "ok" : "warn", text: result.message });
    setBusy(false);
  };

  const remove = async () => {
    await apiKeys.remove(provider);
    setEditing(false);
    setNote({ tone: "ok", text: "Key removed from this browser." });
  };

  return (
    <div className="key-card">
      <div className="key-head">
        <div className="set-info">
          <span className="set-title">{info.title}</span>
          <span className="set-desc">{info.blurb}</span>
        </div>
        {apiKeys.ready && <span className={`key-status ${saved ? "on" : ""}`}>{saved ? "Connected" : "Not set"}</span>}
      </div>

      {entering ? (
        <form className="key-form" onSubmit={submit} autoComplete="off">
          <div className="key-input">
            <input ref={input} type={show ? "text" : "password"} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={info.placeholder} aria-label={info.title} autoComplete="off" autoCapitalize="off" autoCorrect="off"
              spellCheck={false} data-1p-ignore data-lpignore="true" data-form-type="other" />
            <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? "Hide key" : "Show key"} title={show ? "Hide key" : "Show key"}>
              {show ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
            </button>
          </div>
          <button type="submit" className="btn small primary" disabled={!text.trim() || busy}>{busy ? "Checking…" : "Save"}</button>
          {saved && <button type="button" className="btn small ghost" onClick={() => { setEditing(false); setText(""); setNote(null); }}>Cancel</button>}
        </form>
      ) : (
        <div className="key-saved">
          <code aria-label="Saved key, hidden">{maskKey(saved!)}</code>
          <span className="spacer" />
          <button type="button" className="btn small ghost" onClick={() => { setEditing(true); setNote(null); }}>Replace</button>
          <button type="button" className="btn small ghost danger" onClick={remove}>Remove</button>
        </div>
      )}

      {note && <p className={`key-note ${note.tone}`} role="status">{note.text}</p>}
      <a className="key-link" href={info.link} target="_blank" rel="noopener noreferrer">{info.linkLabel}</a>
    </div>
  );
}

// Pages that need an API key stay blurred behind this overlay until the key is added.
const LOCKS = {
  anthropic: { title: "Anthropic API key required", text: "Add your key to choose a model and generate videos." },
  elevenlabs: { title: "ElevenLabs API key required", text: "Add your key to use voice and sound effects." },
};

function LockOverlay({ title, text, onAdd }: { title: string; text: string; onAdd: () => void }) {
  return (
    <div className="lock-overlay">
      <div className="lock-card" role="alert">
        <span className="lock-icon" aria-hidden="true"><IconLock width={20} height={20} /></span>
        <h4>{title}</h4>
        <p>{text}</p>
        <button type="button" className="btn primary" onClick={onAdd}>Add key</button>
      </div>
    </div>
  );
}

interface Props {
  user: User;
  signedIn: boolean;
  theme: Theme;
  onTheme: (t: Theme) => void;
  accent: Accent;
  onAccent: (a: Accent) => void;
  model: ModelKey;
  onModel: (m: ModelKey) => void;
  mode: Engine;
  onMode: (m: Engine) => void;
  animation: AnimationStyle;
  onAnimation: (a: AnimationStyle) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  apiKeys: ApiKeys;
  audioPrefs: AudioPrefs;
  onAudioPrefs: (patch: Partial<AudioPrefs>) => void;
  initialTab?: SettingsTab;
  onClose: () => void;
}

export function SettingsModal({ user, signedIn, theme, onTheme, accent, onAccent, model, onModel, mode, onMode, animation, onAnimation, effort, onEffort, apiKeys, audioPrefs, onAudioPrefs, initialTab = "account", onClose }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<TabId>(initialTab);
  const active = TABS.find((t) => t.id === tab)!;
  const { voices, error: voiceError } = useVoices(tab === "voice" ? apiKeys.keys.elevenlabs : null);
  const lock = !apiKeys.ready ? null
    : tab === "model" && !apiKeys.keys.anthropic ? LOCKS.anthropic
    : (tab === "voice" || tab === "sound") && !apiKeys.keys.elevenlabs ? LOCKS.elevenlabs
    : null;

  useEffect(() => {
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={card} className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" tabIndex={-1}>
        <nav className="set-nav" role="tablist" aria-orientation="vertical" aria-label="Settings categories">
          <h2 id="settingsTitle">Settings</h2>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`set-tab ${tab === id ? "on" : ""}`}
              onClick={() => setTab(id)}>
              <Icon width={17} height={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="set-main" role="tabpanel">
          <header className="modal-head">
            <h3>{active.label}</h3>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings"><IconClose /></button>
          </header>
          <div className={`set-body ${lock ? "locked" : ""}`}>
            <div className="locked-content" aria-hidden={lock ? true : undefined} inert={lock ? true : undefined}>
            {tab === "account" && (
              <section className="set-section">
              <div className="set-row">
                <div className="set-who">
                  <Avatar user={user} size={40} />
                  <div className="user-text">
                    <span className="user-name">{user.name}</span>
                    {user.email && <span className="user-email">{user.email}</span>}
                  </div>
                </div>
                <button type="button" className="btn small" disabled title="Sign in is coming soon">
                  {signedIn ? "Sign out" : "Sign in"}
                </button>
              </div>
                  </section>
            )}
            {tab === "model" && (
              <section className="set-section">
              <div className="set-row set-gap">
                <div className="set-info">
                  <span className="set-title">Model</span>
                  <span className="set-desc">{MODEL_INFO[model].desc}</span>
                </div>
                <Select<ModelKey> label="Model" value={model} onChange={onModel}
                  options={MODEL_KEYS.map((key) => ({ value: key, label: MODEL_INFO[key].name }))} />
              </div>
              <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Protocol</span>
                    <span className="set-desc">Solo: your chosen model writes the whole video. Team: it plans the shots and Haiku agents animate each scene in parallel. Edits always go to your chosen model. Applies to the current video.</span>
                  </div>
                  <Segmented label="Protocol" value={mode} options={ENGINES} onChange={onMode} />
                </div>
                <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Effort</span>
                    <span className="set-desc">How hard Claude thinks. Higher is slower but more polished.</span>
                  </div>
                  <Segmented label="Effort" value={effort} options={EFFORTS.map((v) => ({ value: v, label: EFFORT_LABELS[v] }))} onChange={onEffort} />
                </div>
                <p className="set-foot">Used for new videos and edits. In Team mode this model plans the shots, and scenes are always animated by Haiku.</p>
              </section>
            )}
            {tab === "animation" && (
              <section className="set-section">
                <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Animation style</span>
                    <span className="set-desc">{ANIMATION_STYLES.find((a) => a.value === animation)?.desc}</span>
                  </div>
                  <Select<AnimationStyle> label="Animation style" value={animation} onChange={onAnimation}
                    options={ANIMATION_STYLES.map((a) => ({ value: a.value, label: a.label }))} />
                </div>
                <p className="set-foot">Applies to the current video, for new versions and edits. It sets the easing, pacing, entrances, transitions and camera movement so results stay consistent. In Team mode the director and every scene animator follow the same style. Your prompt can still ask for something specific, like "one slow push-in at the end".</p>
              </section>
            )}
            {tab === "appearance" && (
              <section className="set-section">
              <div className="set-row">
                <div className="set-info">
                  <span className="set-title">Theme</span>
                  <span className="set-desc">System follows your device's light or dark setting.</span>
                </div>
                <ThemeSwitch theme={theme} onTheme={onTheme} />
              </div>
              <div className="set-row set-gap">
                <div className="set-info">
                  <span className="set-title">Accent color</span>
                  <span className="set-desc">Choose the color used for highlights throughout the app.</span>
                </div>
                <div className="accent-options" role="radiogroup" aria-label="Accent color">
                  {ACCENTS.map(({ value, label, color }) => (
                    <button key={value} type="button" className="accent-option" role="radio"
                      aria-label={label} aria-checked={accent === value} title={label}
                      style={{ backgroundColor: color }} onClick={() => onAccent(value)} />
                  ))}
                </div>
              </div>
              </section>
            )}
            {tab === "api" && (
              <section className="set-section">
                <div className="key-list">
                  {KEY_INFO.map((info) => <KeyCard key={info.provider} info={info} apiKeys={apiKeys} />)}
                </div>
                <p className="set-foot">
                  Keys are encrypted in this browser and sent only to this app's server, which passes them to Anthropic or ElevenLabs for each request. They are never stored on the server or written to logs, and saved keys are never shown in full. Use HTTPS if you host this app online.
                  {!apiKeys.persistent && " This browser can't encrypt saved keys here, so they are only kept until you close the tab."}
                </p>
              </section>
            )}
            {tab === "voice" && (
              <section className="set-section">
                <div className="set-row">
                  <div className="set-info">
                    <span className="set-title">Narration</span>
                    <span className="set-desc">Claude writes a voiceover timed to your animation, and ElevenLabs reads it.</span>
                  </div>
                  <Switch label="Narration" checked={audioPrefs.narration} onChange={(narration) => onAudioPrefs({ narration })} />
                </div>
                <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Voice</span>
                    <span className="set-desc">{voiceError ?? (voices?.find((v) => v.id === audioPrefs.voiceId)?.desc || "Who narrates your videos.")}</span>
                  </div>
                  <div className="voice-pick">
                    <VoicePreview url={voices?.find((v) => v.id === audioPrefs.voiceId)?.preview ?? null} />
                    <Select<string> label="Voice" value={audioPrefs.voiceId} disabled={!audioPrefs.narration}
                      onChange={(id) => onAudioPrefs({ voiceId: id, voiceName: voices?.find((v) => v.id === id)?.name ?? id })}
                      options={voices?.length
                        ? (voices.some((v) => v.id === audioPrefs.voiceId) ? voices : [{ id: audioPrefs.voiceId, name: audioPrefs.voiceName }, ...voices])
                            .map((v) => ({ value: v.id, label: v.name }))
                        : [{ value: audioPrefs.voiceId, label: voices ? audioPrefs.voiceName : `${audioPrefs.voiceName}${voiceError ? "" : " (loading…)"}` },
                           ...(audioPrefs.voiceId === DEFAULT_VOICE.id ? [] : [{ value: DEFAULT_VOICE.id, label: DEFAULT_VOICE.name }])]} />
                  </div>
                </div>
                <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Narration volume</span>
                    <span className="set-desc">Applies to playback and exported videos.</span>
                  </div>
                  <Volume label="Narration volume" value={audioPrefs.narrationVolume} onChange={(narrationVolume) => onAudioPrefs({ narrationVolume })} />
                </div>
                <AudioWhen prefs={audioPrefs} onPrefs={onAudioPrefs} />
                <p className="set-foot">Narration uses your ElevenLabs credits (about one credit per character) and a short planning request on your Anthropic key.</p>
              </section>
            )}
            {tab === "sound" && (
              <section className="set-section">
                <div className="set-row">
                  <div className="set-info">
                    <span className="set-title">Sound effects</span>
                    <span className="set-desc">Sounds that land on the motion on screen, like whooshes, clicks, impacts and a quiet ambient bed.</span>
                  </div>
                  <Switch label="Sound effects" checked={audioPrefs.sfx} onChange={(sfx) => onAudioPrefs({ sfx })} />
                </div>
                <div className="set-row set-gap">
                  <div className="set-info">
                    <span className="set-title">Volume</span>
                    <span className="set-desc">How loud sound effects are under the narration.</span>
                  </div>
                  <Volume label="Sound effects volume" value={audioPrefs.sfxVolume} onChange={(sfxVolume) => onAudioPrefs({ sfxVolume })} />
                </div>
                <AudioWhen prefs={audioPrefs} onPrefs={onAudioPrefs} />
                <p className="set-foot">Each sound effect uses ElevenLabs credits based on its length. Changes apply to audio you generate from now on; volume changes apply right away.</p>
              </section>
            )}
            {tab === "storage" && (
              <section className="set-section">
              <div className="set-row">
                <div className="set-info">
                  <span className="set-title">Saved in this browser</span>
                  <span className="set-desc">Your videos and settings stay on this device until accounts are available.</span>
                </div>
              </div>
                  </section>
            )}
            </div>
            {lock && <LockOverlay title={lock.title} text={lock.text} onAdd={() => setTab("api")} />}
          </div>
        </div>
      </div>
    </div>
  );
}
