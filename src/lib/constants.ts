import type { Aspect, Effort, Engine, Settings } from "../types";

export const ASPECTS: Record<Aspect, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

export const DURATIONS = [5, 8, 10, 15, 20, 30];
export const FPS_OPTIONS = [24, 30, 60];

export const EFFORT_LABELS: Record<Effort, string> = { low: "Fast", medium: "Balanced", high: "Best" };
export const ENGINE_LABELS: Record<Engine, string> = { solo: "Solo · Opus", team: "Team · Opus + Haiku" };

export const DEFAULT_SETTINGS: Settings = { aspect: "16:9", duration: 8, fps: 30, cinematic: false, mode: "solo" };

export const SUGGESTIONS = [
  "A kinetic typography intro that spells out AERO in bold, staggered letters on a deep navy background",
  'Product teaser: a glowing orb pulses, splits into particles, and reforms into the words "Coming Soon"',
  "An animated line chart that draws itself while a counter ticks up to 1,000,000 users",
  "A calm, seamless loop of flowing noise lines in sunset colors",
];

export const dims = (s: Settings): [number, number] => ASPECTS[s.aspect] ?? ASPECTS["16:9"];
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function titleFrom(prompt: string) {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 46) + "…" : t;
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
