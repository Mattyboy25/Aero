import { KEY_HEADERS } from "./keys";

/**
 * Asks Claude how long a video should be (Auto length). Returns whole seconds, never more than
 * `max`, or null when it couldn't be decided, in which case the current length is kept.
 */
export async function planLength(a: { prompt: string; current?: number; max: number; key: string; signal: AbortSignal }): Promise<{ seconds: number; reason: string } | null> {
  try {
    const res = await fetch("/api/length", {
      method: "POST", signal: a.signal,
      headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: a.key },
      body: JSON.stringify({ prompt: a.prompt, current: a.current, max: a.max }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return Number.isFinite(d.seconds) ? { seconds: Math.min(a.max, Math.max(1, Math.round(d.seconds))), reason: String(d.reason || "") } : null;
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return null;
  }
}
