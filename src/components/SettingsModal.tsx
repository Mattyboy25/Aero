import { useEffect, useRef } from "react";
import type { ModelKey, Theme } from "../types";
import { MODEL_INFO, MODEL_KEYS } from "../lib/constants";
import type { User } from "../lib/user";
import { Avatar, ThemeSwitch } from "./UserMenu";
import { IconCheck, IconClose } from "./Icons";

interface Props {
  user: User;
  signedIn: boolean;
  theme: Theme;
  onTheme: (t: Theme) => void;
  model: ModelKey;
  onModel: (m: ModelKey) => void;
  onClose: () => void;
}

export function SettingsModal({ user, signedIn, theme, onTheme, model, onModel, onClose }: Props) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={card} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" tabIndex={-1}>
        <header className="modal-head">
          <h2 id="settingsTitle">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings"><IconClose /></button>
        </header>

        <section className="set-section">
          <h3>Account</h3>
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

        <section className="set-section">
          <h3>Model</h3>
          <div className="model-list" role="radiogroup" aria-label="Model">
            {MODEL_KEYS.map((key) => (
              <button key={key} type="button" role="radio" aria-checked={model === key}
                className={`model-opt ${model === key ? "on" : ""}`} onClick={() => onModel(key)}>
                <span className="model-text">
                  <span className="set-title">{MODEL_INFO[key].name}</span>
                  <span className="set-desc">{MODEL_INFO[key].desc}</span>
                </span>
                <span className="model-check" aria-hidden="true">{model === key && <IconCheck width={14} height={14} />}</span>
              </button>
            ))}
          </div>
          <p className="set-foot">Used for new videos and edits. In Team mode this model plans the shots, and scenes are always animated by Haiku.</p>
        </section>

        <section className="set-section">
          <h3>Appearance</h3>
          <div className="set-row">
            <div className="set-info">
              <span className="set-title">Theme</span>
              <span className="set-desc">System follows your device's light or dark setting.</span>
            </div>
            <ThemeSwitch theme={theme} onTheme={onTheme} />
          </div>
        </section>

        <section className="set-section">
          <h3>Storage</h3>
          <div className="set-row">
            <div className="set-info">
              <span className="set-title">Saved in this browser</span>
              <span className="set-desc">Your videos and settings stay on this device until accounts are available.</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
