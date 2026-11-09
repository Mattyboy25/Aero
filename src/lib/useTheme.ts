import { useEffect, useState } from "react";
import type { Theme } from "../types";
import { readPref, writePref } from "./storage";

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
