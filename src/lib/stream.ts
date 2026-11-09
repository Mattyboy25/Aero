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
