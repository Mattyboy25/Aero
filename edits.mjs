// Search/replace edits: lets the model change a few lines of the program instead of rewriting it.
//
//   <<<<<<< SEARCH
//   exact lines from the current code
//   =======
//   replacement lines
//   >>>>>>> REPLACE
//
// Blocks are applied in order, and each SEARCH must match exactly one place in the code.

const BLOCK = /<<<<<<< SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n=======[ \t]*\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

export function parseEdits(body) {
  return [...body.matchAll(BLOCK)].map((m) => ({ search: m[1], replace: m[2] }));
}

const norm = (s) => s.replace(/\r\n/g, "\n");

// Finds every index where `needle` occurs in `hay`.
function indexesOf(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

// Whole-line match that ignores leading/trailing whitespace on each line, for when the model
// gets the indentation slightly wrong. Returns [start, end] character offsets or null/"ambiguous".
function looseFind(code, search) {
  const lines = code.split("\n");
  const want = search.split("\n").map((l) => l.trim());
  while (want.length && want[want.length - 1] === "") want.pop();
  if (!want.length) return null;
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k].trim() === w)) hits.push(i);
  }
  if (hits.length !== 1) return hits.length ? "ambiguous" : null;
  const start = lines.slice(0, hits[0]).reduce((n, l) => n + l.length + 1, 0);
  const end = start + lines.slice(hits[0], hits[0] + want.length).join("\n").length;
  return [start, end];
}

// Returns { code } on success or { error } describing the first block that couldn't be applied.
export function applyEdits(code, edits) {
  if (!edits.length) return { error: "No SEARCH/REPLACE blocks were found." };
  let out = norm(code);
  for (const [n, e] of edits.entries()) {
    const search = norm(e.search);
    const replace = norm(e.replace);
    const label = `Edit ${n + 1}`;
    if (!search.trim()) return { error: `${label}: the SEARCH section is empty.` };
    const exact = indexesOf(out, search);
    if (exact.length > 1) return { error: `${label}: the SEARCH text matches ${exact.length} places. Include more surrounding lines to make it unique.` };
    if (exact.length === 1) {
      out = out.slice(0, exact[0]) + replace + out.slice(exact[0] + search.length);
      continue;
    }
    const loose = looseFind(out, search);
    if (loose === "ambiguous") return { error: `${label}: the SEARCH text matches several places. Include more surrounding lines.` };
    if (!loose) return { error: `${label}: the SEARCH text was not found in the current code. First line: ${search.split("\n")[0].trim().slice(0, 80)}` };
    out = out.slice(0, loose[0]) + replace + out.slice(loose[1]);
  }
  return { code: out.endsWith("\n") ? out : out + "\n" };
}
