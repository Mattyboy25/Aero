import { IconChevron } from "./Icons";

interface Props<T extends string | number> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  title?: string;
  disabled?: boolean;
}

// A native select styled as a compact pill: accessible and keyboard-friendly out of the box.
export function Select<T extends string | number>({ value, onChange, options, label, title, disabled }: Props<T>) {
  return (
    <label className={`pill-select ${disabled ? "disabled" : ""}`} title={title}>
      <span className="sr-only">{label}</span>
      <select value={String(value)} disabled={disabled} aria-label={label}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
      <IconChevron width={14} height={14} />
    </label>
  );
}
