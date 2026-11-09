import { useEffect, useState } from "react";
import type { Accent, Theme } from "../types";
import { readPref, writePref } from "./storage";
import { ACCENTS } from "./constants";

const query = () => matchMedia("(prefers-color-scheme: dark)");

// Light, dark, or follow the system. index.html applies the saved choice before first paint.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readPref<Theme>("aero.theme", "system"));

  useEffect(() => {
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && query().matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    writePref("aero.theme", theme);
    if (theme !== "system") return;
    const mq = query();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return [theme, setTheme] as const;
}

export function useAccent() {
  const [accent, setAccent] = useState<Accent>(() => {
    const saved = readPref("aero.accent", "terracotta");
    return ACCENTS.some((option) => option.value === saved) ? saved as Accent : "terracotta";
  });

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    writePref("aero.accent", accent);
  }, [accent]);

  return [accent, setAccent] as const;
}
