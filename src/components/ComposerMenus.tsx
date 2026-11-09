import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Aspect, Settings } from "../types";
import { ASPECTS, DURATIONS, FPS_OPTIONS, MAX_DURATIONS } from "../lib/constants";
import { ACCEPT } from "../lib/attachments";
import { IconChevron, IconFilm, IconPaperclip, IconUpload } from "./Icons";
import { Select } from "./Select";

// The two menus in the composer's button row: the paperclip (attach files) and the Video menu
// (ratio, duration, fps, audio). Both open above their button, in a portal so nothing clips them.

function Popover({ anchor, onClose, width = 320, className = "", label, children }: {
  anchor: RefObject<HTMLElement | null>; onClose: () => void; width?: number; className?: string; label: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 24);
      setPos({
        left: Math.max(12, Math.min(window.innerWidth - w - 12, r.left)), width: w,
        bottom: window.innerHeight - r.top + 8, maxHeight: Math.max(160, r.top - 20),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, width]);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t) && !(t as Element).closest?.(".select-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".select-menu")) { e.stopPropagation(); onClose(); (anchor.current as HTMLElement | null)?.focus(); }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={box} className={`pop-menu ${className}`} style={pos ?? { visibility: "hidden" }} role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>,
    document.body,
  );
}

// ---------- paperclip ----------

export function AttachMenu({ onFiles, disabled, busy }: { onFiles: (files: File[]) => void; disabled?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <input ref={input} type="file" hidden multiple accept={ACCEPT} aria-label="Upload files"
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) onFiles(files); }} />
      <button ref={button} type="button" className={`composer-attach ${open ? "open" : ""}`} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-label="Attach" title="Attach files"
        onClick={() => setOpen((o) => !o)}>
        {busy ? <span className="spinner" /> : <IconPaperclip width={17} height={17} />}
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} width={290} className="attach-pop" label="Attach">
          <button type="button" role="menuitem" className="pop-item" onClick={() => { setOpen(false); input.current?.click(); }}>
            <span className="pop-item-icon"><IconUpload width={17} height={17} /></span>
            <span className="pop-item-text">
              <span className="set-title">Upload files</span>
              <span className="set-desc">Images, video or audio</span>
            </span>
          </button>
          <p className="pop-note">
            Claude looks at images, and at frames taken from a video, to see what you mean. An audio recording becomes the video's narration, with captions, when you start a new video.
          </p>
        </Popover>
      )}
    </>
  );
}

// ---------- Video: ratio, duration, fps, audio ----------

// A row of choices with one sliding highlight that glides to whichever is picked.
function SlideSwitch<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="slide-switch" role="radiogroup" aria-label={label} style={{ "--n": options.length, "--i": i } as CSSProperties}>
      <span className="slide-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function VideoMenu({ settings, onSettings, durationLocked, audioAuto, onAudioAuto, onAudioSettings }: {
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  /** The length comes from an uploaded recording, so it can't be changed. */
  durationLocked: boolean;
  audioAuto: boolean;
  onAudioAuto: (on: boolean) => void;
  onAudioSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const auto = settings.auto && !durationLocked;
  const [w, h] = ASPECTS[settings.aspect] ?? ASPECTS["16:9"];
  const durations = DURATIONS.includes(settings.duration) || auto ? DURATIONS : [...DURATIONS, settings.duration].sort((a, b) => a - b);

  return (
    <>
      <button ref={button} type="button" className={`composer-video ${open ? "open" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        title="Video settings: ratio, duration, frame rate and audio" onClick={() => setOpen((o) => !o)}>
        <IconFilm width={15} height={15} />
        <span>Video · {settings.aspect} · {auto ? "Auto" : `${settings.duration}s`} · {settings.fps}fps</span>
        <IconChevron width={13} height={13} className="composer-video-chevron" />
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} width={340} className="video-pop" label="Video settings">
          <section className="pop-section">
            <div className="pop-head"><span className="pop-label">Ratio</span><span className="pop-hint">{w}×{h} pixels</span></div>
            <SlideSwitch<Aspect> label="Ratio" value={settings.aspect} onChange={(aspect) => onSettings({ aspect })}
              options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: a }))} />
          </section>

          <section className="pop-section">
            <div className="pop-row">
              <div className="set-info">
                <span className="pop-label">Duration</span>
                <span className="pop-hint">{durationLocked ? "Set by your narration recording" : auto ? "Claude picks, up to your max" : "Length of the video"}</span>
              </div>
              <Select<number> portal label="Duration" disabled={durationLocked} value={auto ? 0 : settings.duration}
                onChange={(d) => (d === 0 ? onSettings({ auto: true }) : onSettings({ auto: false, duration: d }))}
                options={[{ value: 0, label: "Auto" }, ...durations.map((d) => ({ value: d, label: `${d}s` }))]} />
            </div>
            {auto && (
              <div className="pop-row">
                <div className="set-info">
                  <span className="pop-label">Max length</span>
                  <span className="pop-hint">Auto never goes past this</span>
                </div>
                <Select<number> portal label="Max length" value={settings.maxDuration}
                  onChange={(maxDuration) => onSettings({ maxDuration })}
                  options={MAX_DURATIONS.map((d) => ({ value: d, label: `${d}s` }))} />
              </div>
            )}
          </section>

          <section className="pop-section">
            <div className="pop-head"><span className="pop-label">Frame rate</span><span className="pop-hint">Frames per second</span></div>
            <SlideSwitch<number> label="Frame rate" value={settings.fps} onChange={(fps) => onSettings({ fps })}
              options={FPS_OPTIONS.map((f) => ({ value: f, label: `${f} fps` }))} />
          </section>

          <section className="pop-section pop-audio">
            <div className="pop-switch-row">
              <div className="set-info">
                <span className="set-title" id="popAudioLabel">Audio</span>
                <span className="set-desc">Add narration and sound effects to each new version.</span>
              </div>
              <button type="button" role="switch" aria-checked={audioAuto} aria-labelledby="popAudioLabel"
                className={`switch ${audioAuto ? "on" : ""}`} onClick={() => onAudioAuto(!audioAuto)}><span className="switch-thumb" /></button>
            </div>
            <button type="button" className="pop-link" onClick={() => { setOpen(false); onAudioSettings(); }}>Voice and sound settings</button>
          </section>
        </Popover>
      )}
    </>
  );
}
