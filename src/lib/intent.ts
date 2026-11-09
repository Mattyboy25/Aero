import type { Attachment, ModelKey, Question, Settings, Turn } from "../types";
import { KEY_HEADERS } from "./keys";

export type Intent =
  | { action: "reply"; message: string }
  | { action: "ask"; message: string; questions: Question[] }
  | { action: "build"; message: string; brief: string };

/** What goes over the wire for attachments: the pictures and what they are, never the previews. */
export const payload = (list?: Attachment[]) =>
  list?.length ? list.map(({ kind, name, duration, images }) => ({ kind, name, duration, images })) : undefined;

/** The chat so far, as plain text for the intent step. Questions are written out so it knows what it asked. */
export function historyOf(turns: Turn[]) {
  return turns.filter((t) => t.role === "user" || !t.pending).map((t) => {
    if (t.role === "user") return { role: "user", text: t.text };
    const asked = t.questions?.length
      ? "\n" + t.questions.map((q) => `[asked] ${q.question} (${q.options.map((o) => o.label).join(" / ")})`).join("\n")
      : "";
    const made = typeof t.version === "number" ? `\n[made version ${t.version + 1}]` : "";
    const failed = t.error ? `\n[failed: ${t.error}]` : "";
    return { role: "assistant", text: `${t.text}${asked}${made}${failed}`.trim() };
  });
}

/**
 * Decides what a message means: just talk, ask questions first, or build. If the step can't be
 * reached it returns "build" with the user's own words, so a request is never dropped.
 */
export async function planIntent(a: {
  message: string; turns: Turn[]; code: string; settings: Settings; model: ModelKey; key: string; signal: AbortSignal;
  attachments?: Attachment[];
}): Promise<Intent> {
  const fallback: Intent = { action: "build", message: "", brief: a.message };
  let res: Response;
  try {
    res = await fetch("/api/intent", {
      method: "POST", signal: a.signal,
      headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: a.key },
      body: JSON.stringify({
        message: a.message, history: historyOf(a.turns), code: a.code, model: a.model, attachments: payload(a.attachments),
        settings: { aspect: a.settings.aspect, duration: a.settings.duration, auto: a.settings.auto, maxDuration: a.settings.maxDuration, animation: a.settings.animation },
      }),
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return fallback;
  }
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Anthropic rejected your API key. Check it in Settings > API.");
  }
  if (!res.ok) return fallback;
  const d = await res.json().catch(() => null);
  if (!d) return fallback;
  if (d.action === "reply" && d.message) return { action: "reply", message: d.message };
  if (d.action === "ask" && Array.isArray(d.questions) && d.questions.length) return { action: "ask", message: d.message || "", questions: d.questions };
  return { action: "build", message: d.message || "", brief: d.brief || a.message };
}

/** The user's answers, written as the message they send back. */
export function formatAnswers(questions: Question[], answers: string[][]) {
  return questions.map((q, i) => `${q.header}: ${answers[i]?.length ? answers[i].join(", ") : "No preference"}`).join("\n");
}
