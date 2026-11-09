import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, placeholder as placeholderExt, rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { tags as t } from "@lezer/highlight";

// Colors come from CSS variables (see styles.css), so the editor follows the light/dark theme.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--syn-property)" },
  { tag: [t.definition(t.variableName), t.className, t.typeName], color: "var(--syn-definition)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-punct)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace', lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "14px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 18px 0 6px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none", paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 8px", opacity: ".6" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)", opacity: "1" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket": { backgroundColor: "var(--surface-3)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--surface-3)" },
  ".cm-foldGutter span": { color: "var(--muted)" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)" },
});

interface Props {
  /** The text to show. Changing it replaces the document unless the user is editing. */
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  readOnly?: boolean;
  /** Keep the view pinned to the end while code streams in. */
  follow?: boolean;
  placeholder?: string;
  label?: string;
}

export function CodeEditor({ value, onChange, onRun, readOnly = false, follow = false, placeholder = "", label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const cb = useRef({ onChange, onRun });
  cb.current = { onChange, onRun };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), foldGutter(), highlightSpecialChars(), history(), drawSelection(), EditorState.allowMultipleSelections.of(true),
          indentOnInput(), syntaxHighlighting(highlight), bracketMatching(), closeBrackets(), rectangularSelection(),
          highlightActiveLine(), highlightActiveLineGutter(), highlightSelectionMatches(),
          javascript(), placeholderExt(placeholder), theme,
          EditorView.contentAttributes.of({ "aria-label": label ?? "Code" }),
          editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
          keymap.of([
            { key: "Mod-Enter", run: () => { cb.current.onRun?.(); return true; } },
            ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
    });
  }, [readOnly]);

  // Follow new code from outside, unless the user is typing in the editor.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.hasFocus && !readOnly) return;
    if (v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
    if (follow) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.length, { y: "end" }) });
  }, [value, follow, readOnly]);

  return <div ref={host} className="code-editor" />;
}
