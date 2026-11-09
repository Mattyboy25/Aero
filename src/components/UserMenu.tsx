import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Theme } from "../types";
import { initials, type User } from "../lib/user";
import { IconMonitor, IconMoon, IconSelector, IconSettings, IconSun } from "./Icons";

export const THEMES: { value: Theme; label: string; Icon: typeof IconSun }[] = [
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
  { value: "system", label: "System", Icon: IconMonitor },
];

export function Avatar({ user, size = 32 }: { user: User; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials(user.name)}
    </span>
  );
}

export function ThemeSwitch({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  return (
    <div className="segmented theme-switch" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, label, Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value}
          className={theme === value ? "on" : ""} onClick={() => onTheme(value)}>
          <Icon width={15} height={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

interface Props {
  user: User;
  signedIn: boolean;
  /** The sidebar is expanded; when collapsed only the avatar shows. */
  expanded: boolean;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onOpenSettings: () => void;
}

// The user station at the bottom of the sidebar. Its menu is a portal with fixed positioning,
// so the sidebar's clipping can't cut it off.
export function UserMenu({ user, signedIn, expanded, theme, onTheme, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = button.current!.getBoundingClientRect();
    setPos(expanded
      ? { left: r.left, bottom: window.innerHeight - r.top + 8, width: Math.max(r.width, 256) }
      : { left: r.right + 10, bottom: window.innerHeight - r.bottom, width: 256 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <>
      <button ref={button} type="button" className={`user-btn ${open ? "open" : ""}`} onClick={toggle}
        aria-haspopup="menu" aria-expanded={open} title={expanded ? undefined : `${user.name} · menu`}>
        <Avatar user={user} />
        <span className="user-text label">
          <span className="user-name">{user.name}</span>
          {user.email && <span className="user-email">{user.email}</span>}
        </span>
        <IconSelector className="label user-chevron" width={16} height={16} />
      </button>

      {open && createPortal(
        <div ref={menu} className="user-menu" role="menu" style={pos}>
          <div className="um-head">
            <Avatar user={user} size={36} />
            <div className="user-text">
              <span className="user-name">{user.name}</span>
              {user.email && <span className="user-email">{user.email}</span>}
            </div>
          </div>
          <div className="um-section">
            <div className="um-label">Theme</div>
            <ThemeSwitch theme={theme} onTheme={onTheme} />
          </div>
          <button type="button" role="menuitem" className="um-item" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <IconSettings width={16} height={16} />
            <span>Settings</span>
          </button>
          {!signedIn && <div className="um-note">Sign in is coming soon. Your videos are saved in this browser for now.</div>}
        </div>,
        document.body
      )}
    </>
  );
}
