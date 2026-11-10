import type { Effort, ModelKey } from "../types";
import { KEY_HEADERS } from "./keys";
import { readEvents } from "./stream";

export interface PlanRequest {
  request: string;
  settings: { width: number; height: number; duration: number; fps: number; animation?: string };
  effort: Effort;
  model: ModelKey;
  narration?: { lines: { start: number; end: number; text: string }[] };
  attachments?: unknown;
  /** The plan so far, for an edit. */
  currentPlan?: string;
  currentCode?: string;
  key: string;
  signal: AbortSignal;
  /** Called with the whole plan so far, each time more of it arrives. */
  onText: (plan: string) => void;
  /** Claude is making targeted edits to the current plan; the updated plan follows when they're applied. */
  onEditing?: () => void;
}

/** Has Claude write (or update) the plan, streaming it as it goes. Resolves with the finished plan. */
export async function writePlan(r: PlanRequest): Promise<string> {
  const res = await fetch("/api/plan", {
    method: "POST", signal: r.signal,
    headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: r.key },
    body: JSON.stringify({
      request: r.request, settings: r.settings, effort: r.effort, model: r.model, narration: r.narration,
      attachments: r.attachments, currentPlan: r.currentPlan || undefined, currentCode: r.currentCode || undefined,
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
  let plan = "";
  let stop: string | null = null;
  for await (const e of readEvents(res)) {
    if (e.type === "text") { plan += e.text; r.onText(plan); }
    else if (e.type === "editing") r.onEditing?.();
    else if (e.type === "replace") { plan = e.text; r.onText(plan); }
    else if (e.type === "restart") { plan = ""; r.onText(plan); } // a fallback model starts the plan over
    else if (e.type === "error") throw new Error(e.message);
    else if (e.type === "done") stop = e.stop_reason;
  }
  if (stop === "refusal") throw new Error("Claude declined to plan this video. Try rephrasing it.");
  if (!plan.trim()) throw new Error("Claude didn't write a plan. Try again.");
  return plan.trim() + "\n";
}
