import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// Makes Markdown in the editor read like a document: sized headings, bullets, code blocks, quotes,
// rules, and a swatch beside every hex color. The Markdown marks (#, -, **, `) are hidden, except on
// the lines the cursor is on, so the plan stays plain text you can edit.

class Bullet extends WidgetType {
  toDOM() { const s = document.createElement("span"); s.className = "md-bullet"; s.textContent = "•"; return s; }
  eq() { return true; }
  ignoreEvent() { return false; }
}
const bullet = new Bullet();

class Swatch extends WidgetType {
  constructor(readonly color: string) { super(); }
  toDOM() {
    const s = document.createElement("span");
    s.className = "md-swatch";
    s.style.background = this.color;
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  eq(other: Swatch) { return other.color === this.color; }
}

const HEX = /(^|[^\w&#])(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))(?![0-9a-zA-Z_])/g;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // While the editor has focus, the lines with the cursor or selection show their raw Markdown.
  const active = new Set<number>();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);

  const out: Range<Decoration>[] = [];
  const lines = new Map<number, { cls: Set<string>; style?: string }>();
  const addLine = (pos: number, cls: string, style?: string) => {
    const from = doc.lineAt(pos).from;
    const e = lines.get(from) ?? { cls: new Set<string>() };
    cls.split(" ").forEach((c) => e.cls.add(c));
    if (style) e.style = style;
    lines.set(from, e);
  };
  const eachLine = (from: number, to: number, fn: (lineFrom: number, i: number, last: boolean) => void) => {
    const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to - (to > from && doc.sliceString(to - 1, to) === "\n" ? 1 : 0))).number;
    for (let n = first; n <= last; n++) fn(doc.line(n).from, n - first, n === last);
  };
  // Hide a mark and the space after it.
  const hide = (from: number, to: number) => {
    const end = doc.lineAt(from).to;
    const stop = to < end && doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    if (stop > from) out.push(Decoration.replace({}).range(from, stop));
  };

  syntaxTree(state).iterate({
    enter: (n) => {
      const name = n.name;
      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading) { addLine(n.from, `md-h md-h${heading[1]}`); return; }
      switch (name) {
        case "HeaderMark":
          if (!isActive(n.from)) {
            // A closing "##" at the end of a heading goes too, with the space before it.
            const line = doc.lineAt(n.from);
            if (n.from > line.from && doc.sliceString(n.from - 1, n.from) === " ") out.push(Decoration.replace({}).range(n.from - 1, n.to));
            else hide(n.from, n.to);
          }
          break;
        case "ListItem": {
          let depth = -1;
          for (let p = n.node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") depth++;
          addLine(n.from, "md-li", `--depth: ${Math.max(0, depth)}`);
          break;
        }
        case "ListMark": {
          const ordered = n.node.parent?.parent?.name === "OrderedList";
          if (ordered) out.push(Decoration.mark({ class: "md-olmark" }).range(n.from, n.to));
          else if (!isActive(n.from)) {
            const stop = doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
            out.push(Decoration.replace({ widget: bullet }).range(n.from, stop));
          } else out.push(Decoration.mark({ class: "md-listmark" }).range(n.from, n.to));
          break;
        }
        case "Blockquote":
          eachLine(n.from, n.to, (from) => addLine(from, "md-quote"));
          break;
        case "QuoteMark":
          if (!isActive(n.from)) hide(n.from, n.to);
          break;
        case "FencedCode":
        case "CodeBlock":
          eachLine(n.from, n.to, (from, i, last) => addLine(from, `md-codeblock${i === 0 ? " md-codeblock-start" : ""}${last ? " md-codeblock-end" : ""}`));
          break;
        case "CodeMark":
          // Backticks and code fences only show while their line is being edited; an empty fence line
          // then reads as the code block's top or bottom edge.
          if (!isActive(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
          else if (n.node.parent?.name !== "InlineCode") out.push(Decoration.mark({ class: "md-fence" }).range(n.from, n.to));
          break;
        case "CodeInfo":
          if (!isActive(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
          else out.push(Decoration.mark({ class: "md-fence" }).range(n.from, n.to));
          break;
        case "InlineCode":
          out.push(Decoration.mark({ class: "md-inline-code" }).range(n.from, n.to));
          break;
        case "EmphasisMark":
        case "StrikethroughMark":
          if (!isActive(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
          break;
        case "HorizontalRule":
          addLine(n.from, "md-hr");
          if (!isActive(n.from)) out.push(Decoration.replace({}).range(n.from, n.to));
          break;
        case "Table":
          eachLine(n.from, n.to, (from) => addLine(from, "md-table"));
          return false;
      }
    },
  });

  // A swatch before each hex color, so a palette can be read at a glance.
  const text = doc.toString();
  for (const m of text.matchAll(HEX)) {
    out.push(Decoration.widget({ widget: new Swatch(m[2]), side: -1 }).range(m.index! + m[1].length));
  }

  for (const [from, e] of lines) {
    out.push(Decoration.line({ class: [...e.cls].join(" "), attributes: e.style ? { style: e.style } : undefined }).range(from));
  }
  return Decoration.set(out, true);
}

export const markdownLook = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.focusChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = build(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

// The look itself. Lines keep their own padding (not margins), which CodeMirror measures correctly.
export const markdownTheme = EditorView.theme({
  ".cm-line.md-h": { fontWeight: "700", color: "var(--text)", letterSpacing: "-0.01em" },
  ".cm-line.md-h1": { fontSize: "1.75em", lineHeight: "1.25", paddingTop: "6px", paddingBottom: "12px" },
  ".cm-line.md-h2": { fontSize: "1.22em", lineHeight: "1.35", paddingTop: "22px", paddingBottom: "6px" },
  ".cm-line.md-h3": { fontSize: "1.05em", paddingTop: "14px", paddingBottom: "2px" },
  ".cm-line.md-h4, .cm-line.md-h5, .cm-line.md-h6": { fontSize: "0.95em", paddingTop: "10px", color: "var(--text-2)" },

  ".cm-line.md-li": { paddingLeft: "calc(26px + var(--depth, 0) * 1.4em + 1.3em)", textIndent: "-1.3em" },
  ".md-bullet": { display: "inline-block", width: "1.3em", textIndent: "0", color: "var(--accent)", fontWeight: "700" },
  ".md-listmark, .md-olmark": { color: "var(--accent)", fontWeight: "600", fontVariantNumeric: "tabular-nums" },
  ".md-olmark": { display: "inline-block", minWidth: "1.3em", textIndent: "0" },

  ".cm-line.md-quote": {
    paddingLeft: "calc(26px + 14px)", color: "var(--text-2)",
    background: "linear-gradient(var(--accent), var(--accent)) no-repeat 26px 0 / 3px 100%",
  },

  ".cm-line.md-codeblock": {
    paddingLeft: "40px", fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace', fontSize: "0.86em", lineHeight: "1.6",
    background: "linear-gradient(var(--md-code-bg), var(--md-code-bg)) no-repeat 26px 0 / calc(100% - 52px) 100%",
  },
  ".cm-line.md-codeblock-start": { paddingTop: "8px" },
  ".cm-line.md-codeblock-end": { paddingBottom: "8px" },
  ".md-fence": { color: "var(--muted)" },
  ".md-inline-code": {
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace', fontSize: "0.86em",
    background: "var(--md-code-bg)", borderRadius: "5px", padding: "1px 5px", color: "var(--text)",
  },

  ".cm-line.md-hr": { paddingTop: "8px", paddingBottom: "8px", background: "linear-gradient(var(--line), var(--line)) no-repeat 26px 50% / calc(100% - 52px) 1px" },

  ".cm-line.md-table": { fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace', fontSize: "0.86em" },

  ".md-swatch": {
    display: "inline-block", width: "0.85em", height: "0.85em", marginRight: "4px", verticalAlign: "-0.08em",
    borderRadius: "3px", boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, .35)",
  },
});
