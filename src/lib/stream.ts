// Reads the server-sent events that /api/generate streams back.
export async function* readEvents(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        try { yield JSON.parse(line.slice(6)); } catch { /* skip malformed */ }
      }
    }
  }
}

// Splits "description ```javascript code ```" into its parts, tolerating a partial stream.
export function splitResponse(raw: string) {
  const open = raw.match(/```[a-zA-Z]*[ \t]*\n/);
  if (!open || open.index === undefined) return { summary: raw.trim(), code: "", inCode: false, complete: false };
  const summary = raw.slice(0, open.index).trim();
  const rest = raw.slice(open.index + open[0].length);
  const close = rest.search(/\n?```/);
  const code = close === -1 ? rest : rest.slice(0, close);
  return { summary, code: code.replace(/\s+$/, "") + "\n", inCode: close === -1, complete: close !== -1 };
}

/**
 * Joins a continuation onto the code written before a reply was cut off. The model is told to start
 * with the next line, but may reopen a code fence or repeat the last line or two, so those are dropped.
 * While the continuation is still streaming (`done` false), its last line may be half written, so only
 * whole lines are compared.
 */
export function mergeContinuation(base: string, cont: string, done = false) {
  const text = cont.replace(/^\s*```[a-zA-Z]*[ \t]*\n/, "").replace(/^\n+/, "");
  if (!text.trim()) return base;
  const lines = text.split("\n");
  const whole = done ? lines.length : lines.length - 1;
  const before = base.split("\n");
  let drop = 0;
  for (let n = Math.min(40, before.length, whole); n >= 1 && !drop; n--) {
    const tail = before.slice(-n);
    if (!tail.every((l, i) => l.trimEnd() === lines[i].trimEnd())) continue;
    // A lone "}" or "ctx.restore();" repeating is far more likely real code than an echo, so a match
    // has to be long enough to be an echo.
    const size = tail.join("").replace(/\s+/g, "").length;
    if ((n === 1 && size >= 16) || (n >= 2 && size >= 24)) drop = n;
  }
  const rest = lines.slice(drop).join("\n");
  return rest ? `${base}\n${rest}` : base;
}
