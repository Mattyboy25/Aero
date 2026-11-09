import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Question } from "../types";
import { IconCheck, IconClose } from "./Icons";

interface Props {
  questions: Question[];
  onSubmit: (answers: string[][]) => void;
  onSkip: () => void;
}

// Questions the assistant asks before building, shown above the composer. One tab per question
// plus a Submit tab, like VS Code's question picker. Every question also takes a typed answer.
export function QuestionPicker({ questions, onSubmit, onSkip }: Props) {
  const n = questions.length;
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => questions.map(() => ""));
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);

  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  // Each tab starts with its first option (or the current answer) highlighted.
  useEffect(() => {
    if (tab >= n) return;
    const q = questions[tab];
    const i = q.options.findIndex((o) => answers[tab].includes(o.label));
    setActive(i === -1 ? 0 : i);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmitTab = tab === n;
  const q = questions[tab];
  const otherRow = q ? q.options.length : -1;
  const answeredCount = answers.filter((a) => a.length).length;

  const go = (t: number) => setTab(Math.max(0, Math.min(n, t)));
  const setAnswer = (qi: number, next: string[]) => setAnswers((a) => a.map((x, i) => (i === qi ? next : x)));

  const pick = (label: string) => {
    if (!q) return;
    if (q.multiSelect) {
      const cur = answers[tab];
      setAnswer(tab, cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]);
    } else {
      setAnswer(tab, [label]);
      go(tab + 1);
    }
  };
  // A typed answer replaces the options for a single choice, or joins them for a multi choice.
  const commitOther = (advance = false) => {
    if (!q) return;
    const text = others[tab].trim();
    const known = new Set(q.options.map((o) => o.label));
    const picked = answers[tab].filter((x) => known.has(x));
    if (q.multiSelect) setAnswer(tab, text ? [...picked, text] : picked);
    else if (text) setAnswer(tab, [text]);
    if (advance && (text || q.multiSelect)) go(tab + 1);
  };
  const customOf = (qi: number) => {
    const known = new Set(questions[qi].options.map((o) => o.label));
    return answers[qi].find((x) => !known.has(x));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const typing = e.target === otherInput.current;
    if (e.key === "Escape") { e.preventDefault(); onSkip(); return; }
    if (typing) {
      if (e.key === "Enter") { e.preventDefault(); commitOther(true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(otherRow - 1); root.current?.focus(); }
      return;
    }
    if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey && tab < n)) { e.preventDefault(); go(tab + 1); return; }
    if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey && tab > 0)) { e.preventDefault(); go(tab - 1); return; }
    if (onSubmitTab) {
      if (e.key === "Enter") { e.preventDefault(); onSubmit(answers); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); const next = Math.min(otherRow, active + 1); setActive(next); if (next === otherRow) otherInput.current?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active === otherRow) otherInput.current?.focus();
      else pick(q.options[active].label);
    } else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < q.options.length) { e.preventDefault(); setActive(i); pick(q.options[i].label); }
      else if (i === q.options.length) { e.preventDefault(); setActive(otherRow); otherInput.current?.focus(); }
    }
  };

  return (
    <div ref={root} className="qp" tabIndex={-1} onKeyDown={onKey} role="group" aria-label="Questions from Claude">
      <div className="qp-head">
        <div className="qp-tabs" role="tablist">
          {questions.map((x, i) => (
            <button key={i} type="button" role="tab" aria-selected={tab === i} className={`qp-tab ${tab === i ? "on" : ""} ${answers[i].length ? "done" : ""}`}
              onClick={() => go(i)} title={x.question}>
              <span className="qp-box" aria-hidden="true">{answers[i].length > 0 && <IconCheck width={10} height={10} />}</span>
              <span>{x.header}</span>
            </button>
          ))}
          <button type="button" role="tab" aria-selected={onSubmitTab} className={`qp-tab submit ${onSubmitTab ? "on" : ""}`} onClick={() => go(n)}>
            <IconCheck width={12} height={12} /><span>Submit</span>
          </button>
        </div>
        <button type="button" className="icon-btn qp-close" onClick={onSkip} aria-label="Skip the questions" title="Skip the questions (Esc)">
          <IconClose width={14} height={14} />
        </button>
      </div>

      {q ? (
        <div className="qp-body" role="tabpanel">
          <div className="qp-question">{q.question}{q.multiSelect && <span className="qp-multi">Pick any</span>}</div>
          <ul className="qp-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
            {q.options.map((o, i) => {
              const on = answers[tab].includes(o.label);
              return (
                <li key={o.label}>
                  <button type="button" role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on}
                    className={`qp-opt ${i === active ? "active" : ""} ${on ? "on" : ""}`}
                    onPointerEnter={() => setActive(i)} onClick={() => { setActive(i); pick(o.label); }}>
                    <span className="qp-num">{i + 1}</span>
                    <span className="qp-text">
                      <span className="qp-label">{o.label}</span>
                      {o.description && <span className="qp-desc">{o.description}</span>}
                    </span>
                    {on && <IconCheck className="qp-tick" width={14} height={14} />}
                  </button>
                </li>
              );
            })}
            <li>
              <div className={`qp-opt qp-other ${active === otherRow ? "active" : ""} ${customOf(tab) ? "on" : ""}`} onPointerEnter={() => setActive(otherRow)}>
                <span className="qp-num">{otherRow + 1}</span>
                <input ref={otherInput} value={others[tab]} placeholder="Type your own answer…" aria-label="Your own answer"
                  onFocus={() => setActive(otherRow)} onBlur={() => commitOther()}
                  onChange={(e) => { const v = e.target.value; setOthers((o) => o.map((x, i) => (i === tab ? v : x))); }} />
              </div>
            </li>
          </ul>
          <div className="qp-foot">
            <span className="qp-hint">{q.multiSelect ? "Space to toggle" : "Enter to choose"} · ←/→ to switch · Esc to skip</span>
            <span className="spacer" />
            {tab > 0 && <button type="button" className="btn small ghost" onClick={() => go(tab - 1)}>Back</button>}
            <button type="button" className="btn small" onClick={() => { commitOther(); go(tab + 1); }}>{tab === n - 1 ? "Review" : "Next"}</button>
          </div>
        </div>
      ) : (
        <div className="qp-body" role="tabpanel">
          <div className="qp-question">Ready to go?</div>
          <ul className="qp-review">
            {questions.map((x, i) => (
              <li key={i}>
                <button type="button" onClick={() => go(i)}>
                  <span className="qp-label">{x.header}</span>
                  <span className={answers[i].length ? "qp-answer" : "qp-answer none"}>{answers[i].length ? answers[i].join(", ") : "No preference"}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="qp-foot">
            <span className="qp-hint">{answeredCount} of {n} answered. Anything left open is Claude's call.</span>
            <span className="spacer" />
            <button type="button" className="btn small ghost" onClick={() => go(n - 1)}>Back</button>
            <button type="button" className="btn small primary" onClick={() => onSubmit(answers)}>Submit</button>
          </div>
        </div>
      )}
    </div>
  );
}
