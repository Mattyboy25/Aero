import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantTurn, Effort, ModelKey, Overlay, Project, Settings, Aspect } from "./types";
import { ASPECTS, DURATIONS, FPS_OPTIONS, MODEL_INFO, dims, titleFrom, uid } from "./lib/constants";
import { load, newProject, readPref, save, writePref } from "./lib/storage";
import { readEvents, splitResponse } from "./lib/stream";
import { RuntimeBridge } from "./lib/runtime";
import { exportMp4, ExportCancelled } from "./lib/exportMp4";
import type { Slosh } from "./lib/slosh";
import { useAccent, useTheme } from "./lib/useTheme";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { CodePane } from "./components/CodePane";
import { ExportDialog, type ExportState } from "./components/ExportDialog";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { useUser } from "./lib/user";
import { KEY_HEADERS, useApiKeys } from "./lib/keys";
import { Select } from "./components/Select";
import { IconDownload, IconSidebar } from "./components/Icons";

const IDLE_TEXT = "Your video will appear here";
const codeOf = (p: Project) => p.versions[p.current]?.code ?? "";

export default function App() {
  const initial = useMemo(load, []);
  const [projects, setProjects] = useState(initial.projects);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [effort, setEffort] = useState<Effort>(initial.effort);
  const [model, setModel] = useState<ModelKey>(initial.model);
  const [theme, setTheme] = useTheme();
  const [accent, setAccent] = useAccent();
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    readPref("aero.sidebar", window.innerWidth > 1100 ? "open" : "closed") === "open");
  const [chatW, setChatW] = useState(() => {
    const n = Number(readPref("aero.chatW", ""));
    return Number.isFinite(n) && n >= 280 ? n : 0; // 0 = use the CSS default
  });
  const [resizing, setResizing] = useState(false);
  const clampChat = (w: number) => Math.round(Math.min(Math.max(w, 280), Math.min(800, window.innerWidth - 480)));
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizing) setChatW(clampChat(window.innerWidth - e.clientX));
  };
  const endResize = () => {
    setResizing(false);
    if (chatW) writePref("aero.chatW", String(chatW));
  };
  const keyResize = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = chatW || (e.currentTarget.nextElementSibling as HTMLElement | null)?.offsetWidth || 400;
    const next = clampChat(cur + (e.key === "ArrowLeft" ? 24 : -24));
    setChatW(next);
    writePref("aero.chatW", String(next));
  };
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [generating, setGenerating] = useState(false);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const userState = useUser();
  const apiKeys = useApiKeys();

  const project = projects.find((p) => p.id === activeId) ?? projects[0];
  const currentCode = codeOf(project);
  const [overlay, setOverlayState] = useState<Overlay>(() => {
    const p = initial.projects.find((x) => x.id === initial.activeId)!;
    return codeOf(p)
      ? { visible: true, busy: true, fading: false, text: "Loading preview…" }
      : { visible: true, busy: false, fading: false, text: IDLE_TEXT };
  });

  const bridge = useMemo(() => new RuntimeBridge(), []);
  const slosh = useRef<Slosh | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const exportCancelled = useRef(false);

  // Async code (streams, iframe messages) reads the latest values through refs.
  const projectRef = useRef(project);
  projectRef.current = project;
  const runtimeErrorRef = useRef(runtimeError);
  runtimeErrorRef.current = runtimeError;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // ---------- persistence ----------
  useEffect(() => {
    const id = setTimeout(() => save({ projects, activeId, effort, model }), 250);
    return () => clearTimeout(id);
  }, [projects, activeId, effort, model]);

  const updateProject = useCallback((id: string, fn: (p: Project) => Project) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)));
  }, []);

  // ---------- preview and loading effect ----------
  const loadPreview = useCallback((p: Project, autoplay: boolean, t?: number) => {
    const code = codeOf(p);
    if (!code || !bridge.booted) return;
    const [W, H] = dims(p.settings);
    playingRef.current = autoplay;
    setPlaying(autoplay);
    bridge.load({
      code, W, H, DURATION: p.settings.duration, FPS: p.settings.fps,
      t: Math.min(t ?? bridge.getTime(), p.settings.duration), autoplay,
    });
  }, [bridge]);

  // While busy, the frame is covered by the sloshing gradient. When idle, it shows a plain placeholder.
  const setOverlay = useCallback((text: string | null, busy: boolean) => {
    setOverlayState((o) => ({ visible: true, busy, fading: false, text: text ?? o.text }));
    if (busy) slosh.current?.cover();
    else slosh.current?.clear();
  }, []);

  // Dissolve the gradient to reveal the video. Skipped while a generation is still running.
  const hideOverlay = useCallback((force = false) => {
    const s = slosh.current;
    if (!force && abortRef.current && s?.active) return;
    if (!s?.active) { setOverlayState((o) => ({ ...o, visible: false })); return; }
    setOverlayState((o) => ({ ...o, fading: true }));
    s.reveal(() => {
      if (s.active) return; // a new generation started during the reveal
      setOverlayState((o) => ({ ...o, visible: false, fading: false, busy: false }));
    });
  }, []);

  const onSlosh = useCallback((s: Slosh | null) => {
    slosh.current = s;
    if (s && codeOf(projectRef.current)) s.cover();
  }, []);

  useEffect(() => {
    bridge.handlers = {
      onBooted: () => loadPreview(projectRef.current, false),
      onReady: () => { setRuntimeError(null); hideOverlay(); },
      onError: (message) => { playingRef.current = false; setPlaying(false); hideOverlay(); setRuntimeError(message); },
    };
  }, [bridge, loadPreview, hideOverlay]);

  const canPlay = !!currentCode && !runtimeError;
  const togglePlay = useCallback(() => {
    if (!canPlay) return;
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
    if (next) bridge.play(); else bridge.pause();
  }, [bridge, canPlay]);

  const pause = useCallback(() => {
    if (playingRef.current) bridge.pause();
    playingRef.current = false;
    setPlaying(false);
  }, [bridge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.code === "Space" && !["TEXTAREA", "INPUT", "SELECT", "BUTTON", "A", "SUMMARY"].includes(tag ?? "")) {
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // ---------- generation ----------
  async function generate({ prompt, error }: { prompt: string; error?: string }) {
    if (abortRef.current) return;
    // Generating needs the user's own Anthropic key; send them to add one.
    const anthropicKey = apiKeys.get("anthropic");
    if (!anthropicKey) { setSettingsTab("api"); setSettingsOpen(true); return; }
    const p = projectRef.current;
    const pid = p.id;
    const startCode = codeOf(p);
    const userText = error ? "Fix the error in the current version." : prompt;
    const isFirst = p.versions.length === 0;
    // Team mode builds new videos; edits and fixes go to the chosen model alone.
    const useTeam = p.settings.mode === "team" && !startCode && !error;

    const turn: AssistantTurn = { id: uid(), role: "assistant", text: "", thinking: "", pending: true, phase: "thinking" };
    if (p.settings.mode === "team" && !useTeam) turn.note = `Edits go to ${MODEL_INFO[model].name} directly, so it can see the whole video.`;
    if (useTeam) turn.team = { phase: "planning", scenes: [] };
    updateProject(pid, (q) => ({
      ...q,
      turns: [...q.turns, { id: uid(), role: "user", text: userText }, { ...turn }],
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setLiveCode(null);
    setOverlay(useTeam ? `${MODEL_INFO[model].name} is planning the shots…` : isFirst ? "Claude is thinking…" : "Claude is editing…", true);

    // Stream events arrive faster than the screen refreshes, so push the turn to React once per frame.
    let raf = 0;
    const flush = () => {
      raf = 0;
      const snapshot: AssistantTurn = { ...turn, team: turn.team && { ...turn.team, scenes: turn.team.scenes.map((s) => ({ ...s })) } };
      updateProject(pid, (q) => ({ ...q, turns: q.turns.map((t) => (t.id === turn.id ? snapshot : t)) }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };

    const [width, height] = dims(p.settings);
    let raw = "";
    let stopReason: string | null = null;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: anthropicKey },
        body: JSON.stringify({
          prompt: error ? "Fix the runtime error so the video plays correctly." : prompt,
          code: startCode,
          error: error || "",
          effort,
          model,
          mode: useTeam ? "team" : "solo",
          settings: { width, height, duration: p.settings.duration, fps: p.settings.fps },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }

      for await (const event of readEvents(res)) {
        if (event.type === "thinking") {
          turn.thinking += event.text;
          turn.phase = "thinking";
        } else if (event.type === "text") {
          raw += event.text;
          const { summary, code, inCode } = splitResponse(raw);
          turn.text = summary;
          turn.phase = inCode ? "coding" : "writing";
          if (code) setLiveCode(code);
          if (inCode) setOverlay(`Writing code… ${code.split("\n").length} lines`, true);
        } else if (event.type === "editing") {
          turn.phase = "coding";
          setOverlay("Applying targeted edits…", true);
        } else if (event.type === "retry") {
          // The line edits didn't apply cleanly, so the model is rewriting the whole program instead.
          raw = "";
          turn.text = "";
          turn.note = "Targeted edits didn't apply cleanly, so Claude is rewriting the full program.";
          turn.phase = "thinking";
        } else if (event.type === "fallback") {
          // A fallback model restarts the answer, so drop the partial text.
          raw = "";
          turn.note = `Answered by fallback model ${event.to || ""}`.trim();
        } else if (event.type === "phase" && turn.team) {
          turn.team.phase = event.phase;
          turn.phase = event.phase === "planning" ? "thinking" : "animating";
        } else if (event.type === "plan" && turn.team) {
          turn.team.scenes = event.scenes.map((sc: any) => ({ ...sc, status: "waiting", lines: 0 }));
          turn.text = `Shot list: ${event.scenes.length} scenes. Each one is being animated by its own Haiku agent in parallel.`;
        } else if (event.type === "scene" && turn.team?.scenes[event.index]) {
          const sc = turn.team.scenes[event.index];
          sc.status = event.status;
          if (event.lines) sc.lines = event.lines;
          if (event.error) sc.error = event.error;
          const done = turn.team.scenes.filter((x) => x.status === "done" || x.status === "failed").length;
          setOverlay(`Animating ${turn.team.scenes.length} scenes in parallel · ${done} done`, true);
        } else if (event.type === "error") {
          throw new Error(event.message);
        } else if (event.type === "done") {
          stopReason = event.stop_reason;
        }
        schedule();
      }

      if (stopReason === "refusal") throw new Error("Claude declined this request. Try rephrasing it.");
      const { code, complete } = splitResponse(raw);
      if (!code || !complete) {
        throw new Error(stopReason === "max_tokens"
          ? "The response was cut off before the code finished. Try a simpler request."
          : "Claude didn't return any code. Try rephrasing your request.");
      }

      const latest = projectRef.current;
      const next: Project = {
        ...latest,
        title: isFirst ? titleFrom(prompt) : latest.title,
        versions: [...latest.versions, { code, prompt: userText }],
        current: latest.versions.length,
      };
      turn.version = next.current;
      updateProject(pid, (q) => ({ ...q, title: next.title, versions: next.versions, current: next.current }));
      setRuntimeError(null);
      loadPreview(next, true, 0);
    } catch (err: any) {
      turn.error = err?.name === "AbortError" ? "Stopped." : err?.message || String(err);
      if (startCode) hideOverlay(true);
      else setOverlay(IDLE_TEXT, false);
    } finally {
      cancelAnimationFrame(raf);
      delete turn.pending;
      flush();
      abortRef.current = null;
      setGenerating(false);
      setLiveCode(null);
    }
  }

  const stop = () => abortRef.current?.abort();

  // ---------- project actions ----------
  const openProject = (p: Project) => {
    setActiveId(p.id);
    setRuntimeError(null);
    pause();
    bridge.seek(0);
    if (codeOf(p)) { setOverlay("Loading preview…", true); loadPreview(p, false, 0); }
    else setOverlay(IDLE_TEXT, false);
  };

  const selectProject = (id: string) => {
    if (abortRef.current || id === activeId) return;
    const p = projects.find((x) => x.id === id);
    if (p) openProject(p);
    if (window.innerWidth <= 900) setSidebarOpen(false);
  };

  const createProject = () => {
    if (abortRef.current) return;
    if (project.turns.length === 0) return; // already on a blank video
    const p = newProject(project.settings);
    setProjects((ps) => [p, ...ps]);
    openProject(p);
    if (window.innerWidth <= 900) setSidebarOpen(false);
  };

  const deleteProject = (id: string) => {
    const p = projects.find((x) => x.id === id);
    if (!p || (abortRef.current && id === activeId)) return;
    if (p.turns.length && !confirm(`Delete "${p.title}"? This can't be undone.`)) return;
    const rest = projects.filter((x) => x.id !== id);
    if (!rest.length) {
      const fresh = newProject(p.settings);
      setProjects([fresh]);
      openProject(fresh);
    } else {
      setProjects(rest);
      if (id === activeId) openProject([...rest].sort((a, b) => b.updatedAt - a.updatedAt)[0]);
    }
  };

  const toggleSidebar = () => {
    writePref("aero.sidebar", sidebarOpen ? "closed" : "open");
    setSidebarOpen(!sidebarOpen);
  };

  const changeSettings = (patch: Partial<Settings>) => {
    const next = { ...project, settings: { ...project.settings, ...patch } };
    updateProject(project.id, () => next);
    if ("aspect" in patch || "duration" in patch || "fps" in patch) loadPreview(next, playing);
  };

  const restoreVersion = (i: number) => {
    if (abortRef.current) return;
    const next = { ...project, current: i };
    updateProject(project.id, () => next);
    setRuntimeError(null);
    loadPreview(next, true, 0);
  };

  const runEdits = (code: string) => {
    if (abortRef.current || !code.trim()) return;
    const next: Project = {
      ...project,
      versions: [...project.versions, { code, prompt: "Manual code edit" }],
      current: project.versions.length,
      turns: [
        ...project.turns,
        { id: uid(), role: "user", text: "Edited the code by hand." },
        { id: uid(), role: "assistant", text: "Applied your edits.", thinking: "", version: project.versions.length },
      ],
    };
    updateProject(project.id, () => next);
    setRuntimeError(null);
    loadPreview(next, true, 0);
    setTab("preview");
  };

  const switchTab = (t: "preview" | "code") => {
    setTab(t);
    if (t !== "preview") pause();
  };

  // ---------- export ----------
  const startExport = async () => {
    const [W, H] = dims(project.settings);
    const { fps, duration } = project.settings;
    const resumeAt = bridge.getTime();
    pause();
    exportCancelled.current = false;
    setExportState({ status: "Preparing encoder…", progress: 0, running: true });
    try {
      const blob = await exportMp4({
        bridge, width: W, height: H, fps, duration,
        isCancelled: () => exportCancelled.current,
        lastError: () => runtimeErrorRef.current,
        onProgress: (done, total) => setExportState({ status: `Rendering frame ${done} of ${total}`, progress: done / total, running: true }),
      });
      const name = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "aero-video";
      setExportState({
        status: `Done · ${W}×${H} · ${duration}s · ${(blob.size / 1e6).toFixed(1)} MB`,
        progress: 1, running: false, url: URL.createObjectURL(blob), filename: `${name}.mp4`,
      });
    } catch (err: any) {
      if (err instanceof ExportCancelled) setExportState(null);
      else setExportState((s) => ({ status: `Export failed: ${err?.message || err}`, progress: s?.progress ?? 0, running: false }));
    } finally {
      bridge.seek(resumeAt);
    }
  };

  const closeExport = () => {
    if (exportState?.url) URL.revokeObjectURL(exportState.url);
    setExportState(null);
  };

  // Team mode scenes for the version on screen, shown as markers on the timeline.
  const segments = useMemo(() => {
    const turn = project.turns.find((t) => t.role === "assistant" && t.version === project.current);
    return turn && turn.role === "assistant" && turn.team
      ? turn.team.scenes.map((s) => ({ start: s.start, end: s.end, title: s.title }))
      : [];
  }, [project.turns, project.current]);

  // ---------- render ----------
  const [W, H] = dims(project.settings);
  const codeStatus = generating && liveCode
    ? `${liveCode.split("\n").length - 1} lines`
    : currentCode ? `Version ${project.current + 1} · ${currentCode.split("\n").length - 1} lines` : "No code yet";

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}${resizing ? " resizing" : ""}`}
      style={chatW ? ({ "--chat-w": `${chatW}px` } as React.CSSProperties) : undefined}>
      <Sidebar open={sidebarOpen} onToggle={toggleSidebar} projects={projects} activeId={project.id} busy={generating}
        onSelect={selectProject} onNew={createProject} onDelete={deleteProject} theme={theme} onTheme={setTheme}
        userState={userState} onOpenSettings={() => { setSettingsTab("account"); setSettingsOpen(true); }} />

      <main className="workspace">
        <header className="workspace-head">
          <button type="button" className="icon-btn mobile-only" onClick={toggleSidebar} aria-label="Open sidebar">
            <IconSidebar />
          </button>
          <div className="title-group">
            <h2 className="project-name" title={project.title}>{project.title}</h2>
            {project.versions.length > 0 && (
              <Select<number> label="Version" value={project.current} disabled={generating}
                title="Switch to an earlier version"
                onChange={(i) => { if (i !== project.current) restoreVersion(i); }}
                options={project.versions.map((_, i) => ({ value: i, label: `Version ${i + 1}`, hint: i === project.versions.length - 1 ? "latest" : undefined })).reverse()} />
            )}
          </div>
          <div className="segmented tabs" role="tablist">
            {(["preview", "code"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>
                {t === "preview" ? "Preview" : "Code"}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="head-controls">
            <Select<Aspect> showLabel label="Ratio" value={project.settings.aspect} onChange={(aspect) => changeSettings({ aspect })}
              title={`${W}×${H} pixels`}
              options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: a }))} />
            <Select<number> showLabel label="Duration" value={project.settings.duration} onChange={(duration) => changeSettings({ duration })}
              options={DURATIONS.map((d) => ({ value: d, label: `${d}s` }))} />
            <Select<number> showLabel label="FPS" value={project.settings.fps} onChange={(fps) => changeSettings({ fps })}
              options={FPS_OPTIONS.map((f) => ({ value: f, label: String(f) }))} />
            <button type="button" className="btn primary" onClick={startExport} disabled={!canPlay || generating}>
              <IconDownload width={15} height={15} />Export MP4
            </button>
          </div>
        </header>

        <Preview hidden={tab !== "preview"} bridge={bridge} width={W} height={H}
          duration={project.settings.duration} fps={project.settings.fps}
          overlay={overlay} onSlosh={onSlosh} runtimeError={runtimeError}
          onFix={() => runtimeError && generate({ prompt: "", error: runtimeError })} fixDisabled={generating}
          playing={playing} canPlay={canPlay} onTogglePlay={togglePlay}
          onScrub={(t) => { pause(); bridge.seek(t); }} segments={segments} />
        <CodePane hidden={tab !== "code"} source={liveCode ?? currentCode} currentCode={currentCode} status={codeStatus}
          streaming={generating && liveCode !== null} generating={generating} onRun={runEdits} />
      </main>

      <div className="chat-resizer" role="separator" aria-orientation="vertical" aria-label="Resize chat" tabIndex={0}
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}
        onKeyDown={keyResize} onDoubleClick={() => { setChatW(0); writePref("aero.chatW", ""); }} />
      <Chat turns={project.turns} versionCount={project.versions.length} current={project.current} generating={generating}
        settings={project.settings} effort={effort} modelName={MODEL_INFO[model].name}
        onSend={(prompt) => generate({ prompt })} onStop={stop} onRestore={restoreVersion}
        onSettings={changeSettings} onEffort={setEffort}
        needsKey={apiKeys.ready && !apiKeys.keys.anthropic} onAddKey={() => { setSettingsTab("api"); setSettingsOpen(true); }}
        onOpenSettings={() => { setSettingsTab("model"); setSettingsOpen(true); }} />

      {settingsOpen && (
        <SettingsModal user={userState.user} signedIn={userState.signedIn} theme={theme} onTheme={setTheme}
          accent={accent} onAccent={setAccent} model={model} onModel={setModel}
          mode={project.settings.mode} onMode={(mode) => changeSettings({ mode })} effort={effort} onEffort={setEffort} initialTab={settingsTab}
          apiKeys={apiKeys}
          onClose={() => setSettingsOpen(false)} />
      )}

      {exportState && (
        <ExportDialog state={exportState} onCancel={() => { exportCancelled.current = true; }} onClose={closeExport} />
      )}
    </div>
  );
}
