import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { IconCheck, IconChevron } from "./Icons";

interface Props<T extends string | number> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; /** Muted note shown beside the option in the open menu. */ hint?: string }[];
  label: string;
  title?: string;
  disabled?: boolean;
  /** Show the label as text to the left of the value. */
  showLabel?: boolean;
}

// A custom dropdown so the open menu matches the app. The whole pill is the button, and the
// menu opens downward, or upward when there isn't room below (like the composer at the bottom).
export function Select<T extends string | number>({ value, onChange, options, label, title, disabled, showLabel }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selected = Math.max(0, options.findIndex((o) => o.value === value));

  const openMenu = () => {
    if (disabled) return;
    const r = root.current!.getBoundingClientRect();
    const need = options.length * 34 + 20;
    const below = window.innerHeight - r.bottom;
    setUp(below < need && r.top > below);
    setActive(selected);
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const onKey = (e: KeyboardEvent) => {
    const n = options.length;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openMenu(); }
      return;
    }
    const move = (i: number) => { e.preventDefault(); setActive(i); };
    switch (e.key) {
      case "ArrowDown": move((active + 1) % n); break;
      case "ArrowUp": move((active - 1 + n) % n); break;
      case "Home": move(0); break;
      case "End": move(n - 1); break;
      case "Enter": case " ": e.preventDefault(); choose(active); break;
      case "Escape": e.preventDefault(); setOpen(false); break;
      case "Tab": setOpen(false); break;
    }
  };

  return (
    <div ref={root} className={`pill-select ${disabled ? "disabled" : ""} ${open ? "open" : ""}`} title={title}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={button} type="button" className="select-btn" disabled={disabled} role="combobox"
        aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={`${label}: ${options[selected]?.label}`}
        onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKey}>
        {showLabel && <span className="pill-label">{label}</span>}
        <span className="pill-value">{options[selected]?.label}</span>
        <IconChevron className="pill-chevron" width={14} height={14} />
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className={`select-menu ${up ? "up" : "down"}`}
          onMouseDown={(e) => e.preventDefault()}>
          {options.map((o, i) => (
            <li key={String(o.value)} role="option" aria-selected={i === selected}
              className={`select-opt ${i === active ? "active" : ""} ${i === selected ? "selected" : ""}`}
              onPointerEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span>{o.label}{o.hint && <span className="opt-hint">{o.hint}</span>}</span>
              {i === selected && <IconCheck width={14} height={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
