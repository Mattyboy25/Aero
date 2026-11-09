import type { Effort, ModelKey, Project, Settings } from "../types";
import { DEFAULT_MODEL, DEFAULT_SETTINGS, MODEL_KEYS, titleFrom, uid } from "./constants";

const KEY = "aero.v2";
const LEGACY_KEY = "aero.project.v1";

export interface Saved {
  projects: Project[];
  activeId: string;
  effort: Effort;
  model: ModelKey;
}

export function newProject(settings: Settings = DEFAULT_SETTINGS): Project {
  const now = Date.now();
  return { id: uid(), title: "Untitled video", createdAt: now, updatedAt: now, settings: { ...settings }, turns: [], versions: [], current: -1 };
}

export function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && Array.isArray(saved.projects) && saved.projects.length) {
      const projects: Project[] = saved.projects.map(clean);
      const activeId = projects.some((p) => p.id === saved.activeId) ? saved.activeId : projects[0].id;
      return { projects, activeId, effort: saved.effort || "medium", model: MODEL_KEYS.includes(saved.model) ? saved.model : DEFAULT_MODEL };
    }
    // Bring over the single project saved by the earlier version of the app.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (legacy && Array.isArray(legacy.versions)) {
      const p = newProject(cleanSettings(legacy.settings || {}));
      p.turns = (legacy.turns || []).filter((t: any) => !t.pending).map((t: any) => ({ thinking: "", ...t, id: uid() }));
      p.versions = legacy.versions;
      p.current = Math.min(legacy.current ?? -1, legacy.versions.length - 1);
      if (legacy.versions[0]?.prompt) p.title = titleFrom(legacy.versions[0].prompt);
      return { projects: [p], activeId: p.id, effort: legacy.effort || "medium", model: DEFAULT_MODEL };
    }
  } catch { /* storage unavailable: start fresh */ }
  const p = newProject();
  return { projects: [p], activeId: p.id, effort: "medium", model: DEFAULT_MODEL };
}

// Drops settings that no longer exist (like the removed Cinematic toggle).
function cleanSettings(s: object): Settings {
  const { cinematic: _removed, ...rest } = s as Partial<Settings> & { cinematic?: unknown };
  return { ...DEFAULT_SETTINGS, ...rest };
}

function clean(p: Project): Project {
  return {
    ...p,
    settings: cleanSettings(p.settings),
    turns: p.turns.filter((t) => !(t.role === "assistant" && t.pending)),
    current: Math.min(p.current ?? -1, p.versions.length - 1),
  };
}

export function save(data: Saved) {
  try {
    const projects = data.projects.map((p) => ({ ...p, turns: p.turns.filter((t) => !(t.role === "assistant" && t.pending)) }));
    localStorage.setItem(KEY, JSON.stringify({ ...data, projects }));
  } catch { /* quota or private mode: ignore */ }
}

export function readPref<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
export function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
