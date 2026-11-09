import type { Project, Theme } from "../types";
import { IconFilm, IconMonitor, IconMoon, IconPlus, IconSidebar, IconSun, IconTrash } from "./Icons";

interface Props {
  open: boolean;
  onToggle: () => void;
  projects: Project[];
  activeId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}

const THEMES: { value: Theme; label: string; Icon: typeof IconSun }[] = [
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
  { value: "system", label: "System", Icon: IconMonitor },
];

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Sidebar(props: Props) {
  const { open, onToggle, projects, activeId, busy, onSelect, onNew, onDelete, theme, onTheme } = props;
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  const next = THEMES[(THEMES.findIndex((t) => t.value === theme) + 1) % THEMES.length];
  const Current = THEMES.find((t) => t.value === theme)!.Icon;

  return (
    <>
      <aside className={`sidebar ${open ? "open" : "collapsed"}`} aria-label="Projects">
        <div className="sidebar-head">
          <div className="brand">
            <span className="logo" aria-hidden="true" />
            <span className="brand-name">Aero</span>
          </div>
          <button type="button" className="icon-btn" onClick={onToggle}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"} title={open ? "Collapse sidebar" : "Expand sidebar"}>
            <IconSidebar />
          </button>
        </div>

        <button type="button" className="side-item new" onClick={onNew} disabled={busy} title="New video">
          <IconPlus />
          <span className="label">New video</span>
        </button>

        <div className="side-section">
          <div className="side-heading label">Videos</div>
          <ul className="project-list">
            {sorted.map((p) => (
              <li key={p.id}>
                <button type="button" className={`side-item project ${p.id === activeId ? "active" : ""}`}
                  onClick={() => onSelect(p.id)} disabled={busy && p.id !== activeId} title={p.title}>
                  <IconFilm />
                  <span className="label project-text">
                    <span className="project-title">{p.title}</span>
                    <span className="project-meta">
                      {p.versions.length ? `${p.versions.length} version${p.versions.length > 1 ? "s" : ""} · ` : ""}{ago(p.updatedAt)}
                    </span>
                  </span>
                </button>
                <button type="button" className="icon-btn delete label" aria-label={`Delete ${p.title}`} title="Delete"
                  disabled={busy && p.id === activeId} onClick={() => onDelete(p.id)}>
                  <IconTrash width={15} height={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="sidebar-foot">
          {open ? (
            <div className="segmented theme-switch" role="radiogroup" aria-label="Theme">
              {THEMES.map(({ value, label, Icon }) => (
                <button key={value} type="button" role="radio" aria-checked={theme === value}
                  className={theme === value ? "on" : ""} onClick={() => onTheme(value)} title={label}>
                  <Icon width={15} height={15} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="icon-btn" onClick={() => onTheme(next.value)}
              aria-label={`Theme: ${theme}. Switch to ${next.label}`} title={`Theme: ${theme}`}>
              <Current />
            </button>
          )}
        </div>
      </aside>
      {open && <div className="scrim" onClick={onToggle} aria-hidden="true" />}
    </>
  );
}
