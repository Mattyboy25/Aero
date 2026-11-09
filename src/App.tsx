import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantTurn, AudioClip, AudioJob, Effort, ModelKey, Overlay, Project, Settings, Aspect } from "./types";
import { ASPECTS, DURATIONS, FPS_OPTIONS, MODEL_INFO, dims, fmtTime, titleFrom, uid } from "./lib/constants";
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
import { AudioEngine, blobIdOf, mixdown } from "./lib/audioEngine";
import { DEFAULT_UPLOAD_PROMPT, MAX_UPLOAD_BYTES, MAX_UPLOAD_SECONDS, clipsFromUpload, linesFromWords, looksLikeAudio, transcribe } from "./lib/upload";
import { generateAudio, voiceLine } from "./lib/audioGen";
import { deleteClips, putClip } from "./lib/audioStore";
import { useAudioPrefs, type AudioPrefs } from "./lib/audioPrefs";
import { KEY_HEADERS, useApiKeys } from "./lib/keys";
import { Select } from "./components/Select";
import { IconDownload, IconSidebar } from "./components/Icons";

const IDLE_TEXT = "Your video will appear here";
/** Requests that mean "I want captions": these are routed to the narration track. */
const CAPTION_REQUEST = /\b(caption(?:s|ed|ing)?|subtitl(?:e|es|ed|ing)|closed[- ]?captions?|voice[- ]?overs?|narrat(?:e|ed|ion|or|ing)|transcripts?)\b/i;
const codeOf = (p: Project) => p.versions[p.current]?.code ?? "";
// Lane volumes as gains, with the timeline's lane mutes applied.
const laneVolumes = (a: AudioPrefs) => ({
  narration: a.narrationMuted ? 0 : a.narrationVolume / 100,
  sfx: a.sfxMuted ? 0 : a.sfxVolume / 100,
});

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
  const [audioPrefs, setAudioPrefs] = useAudioPrefs();
  const audioPrefsRef = useRef(audioPrefs);
  audioPrefsRef.current = audioPrefs;
  // Narration/sound jobs in progress, keyed by "projectId:versionIndex". Not saved.
  const [audioJobs, setAudioJobs] = useState<Record<string, AudioJob>>({});
  const audioAborts = useRef(new Map<string, AbortController>());

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
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
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

  // ---------- audio playback ----------
  const engine = useMemo(() => new AudioEngine(), []);
  const currentAudio = project.versions[project.current]?.audio;
  useEffect(() => {
    void engine.setClips(currentAudio?.clips ?? [], project.settings.duration);
  }, [engine, currentAudio, project.settings.duration]);
  useEffect(() => {
    engine.setVolumes({ ...laneVolumes(audioPrefs), muted: audioPrefs.muted });
  }, [engine, audioPrefs]);
  // Follow the preview's clock: every time update (play, seek, loop) lines the audio up again.
  useEffect(() => bridge.subscribe(() => engine.sync(bridge.getTime(), playingRef.current)), [bridge, engine]);
  useEffect(() => { if (!playing) engine.stop(); }, [engine, playing]);

  const canPlay = !!currentCode && !runtimeError;
  const togglePlay = useCallback(() => {
    if (!canPlay) return;
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
    if (next) { engine.unlock(); bridge.play(); } else bridge.pause();
  }, [bridge, engine, canPlay]);

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

  // ---------- narration upload (new videos) ----------
  const [uploadJob, setUploadJob] = useState<{ pid: string; name: string; status: "decoding" | "transcribing" | "error"; error?: string } | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);

  // Reads the recording, has ElevenLabs transcribe it, and attaches it to the (still empty) video.
  async function attachAudio(file: File) {
    const key = apiKeys.get("elevenlabs");
    if (!key) { setSettingsTab("api"); setSettingsOpen(true); return; }
    const p = projectRef.current;
    if (p.versions.length || abortRef.current) return;
    const pid = p.id;
    const fail = (error: string) => setUploadJob({ pid, name: file.name, status: "error", error });
    if (!looksLikeAudio(file)) return fail("That doesn't look like an audio file. Try an MP3, WAV or M4A.");
    if (file.size > MAX_UPLOAD_BYTES) return fail("That file is too large. Use one under 60 MB.");

    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadJob({ pid, name: file.name, status: "decoding" });
    try {
      let buf: AudioBuffer;
      try { buf = await engine.decode(file); } catch { throw new Error("This browser couldn't read that audio. Try an MP3, WAV or M4A."); }
      if (buf.duration < 1) throw new Error("That recording is too short.");
      if (buf.duration > MAX_UPLOAD_SECONDS) throw new Error(`That recording is ${fmtTime(buf.duration)} long. For now, uploads can be up to 1:00.`);
      setUploadJob({ pid, name: file.name, status: "transcribing" });
      const { words, language } = await transcribe(file, key, controller.signal);
      const lines = linesFromWords(words);
      const sourceId = uid();
      await putClip(sourceId, file);
      engine.remember(sourceId, buf);
      const old = projectsRef.current.find((x) => x.id === pid)?.upload?.sourceId;
      if (old) void deleteClips([old]);
      updateProject(pid, (q) => ({
        ...q,
        upload: { sourceId, name: file.name, duration: buf.duration, lines, language, voiceover: audioPrefsRef.current.narration },
        settings: { ...q.settings, duration: Math.ceil(buf.duration) },
      }));
      setUploadJob(null);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      fail(err?.message || String(err));
    }
  }

  const removeUpload = () => {
    uploadAbort.current?.abort();
    setUploadJob(null);
    const p = projectRef.current;
    if (!p.upload || p.versions.length) return;
    void deleteClips([p.upload.sourceId]);
    updateProject(p.id, (q) => { const { upload, ...rest } = q; return rest; });
  };
  const setVoiceover = (voiceover: boolean) =>
    updateProject(projectRef.current.id, (q) => (q.upload ? { ...q, upload: { ...q.upload, voiceover } } : q));

  // Stored recordings and clips are shared between versions, so only delete what nothing else uses.
  const blobsInUse = (pid: string, exceptVersion = -1) => {
    const p = projectsRef.current.find((x) => x.id === pid);
    const used = new Set<string>();
    if (p?.upload) used.add(p.upload.sourceId);
    p?.versions.forEach((v, i) => { if (i !== exceptVersion) v.audio?.clips.forEach((c) => used.add(blobIdOf(c))); });
    return used;
  };
  const releaseBlobs = (pid: string, ids: string[], exceptVersion?: number) => {
    const used = blobsInUse(pid, exceptVersion);
    void deleteClips([...new Set(ids)].filter((id) => !used.has(id)));
  };

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
          narration: p.upload ? { lines: p.upload.lines } : undefined,
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
      // An uploaded recording is the video's narration: the first version gets its clips, and later
      // versions keep whatever the version they were made from has.
      const upAudio = latest.upload
        ? (latest.versions.length ? latest.versions[latest.current]?.audio : { clips: clipsFromUpload(latest.upload), createdAt: Date.now() })
        : undefined;
      const next: Project = {
        ...latest,
        title: isFirst ? titleFrom(latest.upload && prompt === DEFAULT_UPLOAD_PROMPT ? latest.upload.name.replace(/\.[^.]+$/, "") : prompt) : latest.title,
        versions: [...latest.versions, { code, prompt: userText, audio: upAudio }],
        current: latest.versions.length,
      };
      turn.version = next.current;
      updateProject(pid, (q) => ({ ...q, title: next.title, versions: next.versions, current: next.current }));
      setRuntimeError(null);
      engine.unlock();
      loadPreview(next, true, 0);
      // Captions only ever come from the narration track (the video code is told never to draw them),
      // so a request for captions or a voiceover always gets narration, even with auto audio off.
      const ap = audioPrefsRef.current;
      const wantsCaptions = !error && CAPTION_REQUEST.test(prompt);
      // Hand over the new version directly: state won't include it until the next render.
      const snapshot: Project = { ...next, turns: next.turns.map((t) => (t.id === turn.id ? { ...turn } : t)) };
      if (latest.upload) {
        // The recording is the narration, so nothing else is generated for it.
        if (wantsCaptions) turn.note = "Captions are made from your uploaded narration, and the recording is the voice over.";
      } else if (wantsCaptions) {
        turn.note = "Captions come from the narration track, so narration is being added to this version. Edit captions on the timeline.";
        startAudio(pid, next.current, false, { narration: true }, snapshot);
      } else if (ap.auto && (ap.narration || ap.sfx)) startAudio(pid, next.current, false, {}, snapshot);
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

  // ---------- narration and sound effects ----------
  const jobKey = (pid: string, vi: number) => `${pid}:${vi}`;
  const setJob = (key: string, job: AudioJob | null) => setAudioJobs((jobs) => {
    const next = { ...jobs };
    if (job) next[key] = job; else delete next[key];
    return next;
  });

  // `interactive`: the user asked for it, so missing keys or settings open Settings.
  // Automatic runs report the problem on the version instead of interrupting.
  // `snapshot`: the project as it is now, when the caller just changed it. React state (and so
  // projectsRef) only catches up on the next render, so a version made a moment ago isn't there yet.
  function startAudio(pid: string, vi: number, interactive = true, force: { narration?: boolean } = {}, snapshot?: Project) {
    const key = jobKey(pid, vi);
    if (audioAborts.current.has(key)) return;
    const anthropic = apiKeys.get("anthropic");
    const elevenlabs = apiKeys.get("elevenlabs");
    const prefs = { ...audioPrefsRef.current, ...force };
    const problem = !anthropic ? "Add your Anthropic API key in Settings > API to plan audio."
      : !elevenlabs ? "Add your ElevenLabs API key in Settings > API to generate audio."
      : !prefs.narration && !prefs.sfx ? "Turn on narration or sound effects in Settings first." : null;
    if (problem) {
      if (interactive) { setSettingsTab(!anthropic || !elevenlabs ? "api" : "voice"); setSettingsOpen(true); }
      else setJob(key, { stage: "error", done: 0, total: 0, error: problem });
      return;
    }
    const p = snapshot ?? projectsRef.current.find((x) => x.id === pid);
    const v = p?.versions[vi];
    if (!p || !v) {
      setJob(key, { stage: "error", done: 0, total: 0, error: "Couldn't find this version's code to add audio to. Try Add narration & sound." });
      return;
    }
    const earlier = p.versions.slice(0, vi).reverse().find((x) => x.audio?.clips.some((c) => c.kind === "narration"))?.audio;
    const previous = earlier?.clips.filter((c) => c.kind === "narration").map((c) => `${c.start.toFixed(1)}s: ${c.text}`).join("\n");
    const turn = p.turns.find((t) => t.role === "assistant" && t.version === vi);
    const scenes = turn?.role === "assistant" && turn.team ? turn.team.scenes.map(({ start, end, title }) => ({ start, end, title })) : [];
    const firstPrompt = p.versions[0]?.prompt;

    const controller = new AbortController();
    audioAborts.current.set(key, controller);
    setJob(key, { stage: "planning", done: 0, total: 0 });
    generateAudio({
      code: v.code, title: p.title, duration: p.settings.duration, scenes, previous,
      prompt: firstPrompt && firstPrompt !== v.prompt ? `${firstPrompt}\n\nLatest change: ${v.prompt}` : v.prompt,
      narration: prefs.narration, sfx: prefs.sfx, voiceId: prefs.voiceId, model,
      keys: { anthropic: anthropic!, elevenlabs: elevenlabs! },
      decode: (b) => engine.decode(b), onDecoded: (id, buf) => engine.remember(id, buf),
      onProgress: (stage, done, total) => setJob(key, { stage, done, total }),
      signal: controller.signal,
    }).then((audio) => {
      const old = projectsRef.current.find((x) => x.id === pid)?.versions[vi]?.audio?.clips.map(blobIdOf) ?? [];
      updateProject(pid, (q) => ({ ...q, versions: q.versions.map((x, i) => (i === vi ? { ...x, audio } : x)) }));
      releaseBlobs(pid, old, vi);
      setJob(key, null);
    }).catch((err) => {
      if (err?.name === "AbortError") setJob(key, null);
      else setJob(key, { stage: "error", done: 0, total: 0, error: err?.message || String(err) });
    }).finally(() => audioAborts.current.delete(key));
  }

  const cancelAudio = (vi: number) => audioAborts.current.get(jobKey(project.id, vi))?.abort();
  const removeAudio = (vi: number) => {
    const ids = project.versions[vi]?.audio?.clips.map(blobIdOf) ?? [];
    updateProject(project.id, (q) => ({ ...q, versions: q.versions.map((x, i) => (i === vi ? { ...x, audio: undefined } : x)) }));
    releaseBlobs(project.id, ids, vi);
    setJob(jobKey(project.id, vi), null);
  };
  const dismissAudioError = (vi: number) => setJob(jobKey(project.id, vi), null);

  // ---------- captions: edit a narration line from the timeline ----------
  const patchClip = (pid: string, vi: number, id: string, patch: Partial<AudioClip>) =>
    updateProject(pid, (q) => ({
      ...q,
      versions: q.versions.map((v, i) => (i === vi && v.audio
        ? { ...v, audio: { ...v.audio, clips: v.audio.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)).sort((a, b) => a.start - b.start) } }
        : v)),
    }));

  // Saves the caption text and timing. The voice clip moves with it, so they stay lined up.
  const editCaption = (id: string, patch: { caption: string; start: number }) => {
    const clip = currentAudio?.clips.find((c) => c.id === id);
    if (!clip) return;
    const caption = patch.caption.trim();
    patchClip(project.id, project.current, id, {
      start: Math.min(project.settings.duration, Math.max(0, patch.start)),
      caption: caption && caption !== clip.text ? caption : undefined,
    });
  };

  // Reads the edited caption aloud with the same voice, so the voice says exactly what the caption shows.
  const revoiceCaption = async (id: string, text: string, start: number) => {
    const pid = project.id, vi = project.current;
    const key = apiKeys.get("elevenlabs");
    if (!key) { setSettingsTab("api"); setSettingsOpen(true); throw new Error("Add your ElevenLabs API key first."); }
    const lines = currentAudio?.clips.filter((c) => c.kind === "narration") ?? [];
    const at = lines.findIndex((c) => c.id === id);
    if (at === -1) return;
    const blob = await voiceLine({
      text: text.trim(), key, voiceId: currentAudio?.voiceId || audioPrefs.voiceId,
      previousText: lines[at - 1]?.text, nextText: lines[at + 1]?.text,
    });
    const buf = await engine.decode(blob);
    const newId = uid();
    await putClip(newId, blob);
    engine.remember(newId, buf);
    patchClip(pid, vi, id, { id: newId, sourceId: undefined, offset: undefined, source: undefined, text: text.trim(), caption: undefined, duration: buf.duration, start: Math.min(project.settings.duration, Math.max(0, start)) });
    void deleteClips([id]);
  };
  const versionJobs: Record<number, AudioJob> = {};
  for (const [k, job] of Object.entries(audioJobs)) {
    const at = k.lastIndexOf(":");
    if (k.slice(0, at) === project.id) versionJobs[Number(k.slice(at + 1))] = job;
  }

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
    p.versions.forEach((_, i) => audioAborts.current.get(jobKey(id, i))?.abort());
    void deleteClips([...(p.upload ? [p.upload.sourceId] : []), ...p.versions.flatMap((v) => v.audio?.clips.map(blobIdOf) ?? [])]);
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
      versions: [...project.versions, { code, prompt: "Manual code edit", audio: project.upload ? project.versions[project.current]?.audio : undefined }],
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
      const clips = currentAudio?.clips ?? [];
      let mix: AudioBuffer | null = null;
      if (clips.length) {
        setExportState({ status: "Mixing narration and sound…", progress: 0, running: true });
        mix = await mixdown(clips, duration, laneVolumes(audioPrefs), (b) => engine.decode(b));
      }
      // Draw the captions into the exported frames, the same lines the preview shows.
      const lines = audioPrefs.captions ? clips.filter((c) => c.kind === "narration").map((c) => ({ start: c.start, end: c.start + c.duration, text: c.caption ?? c.text })) : [];
      bridge.setCaptions(lines.length ? lines : null);
      const { blob, audioSkipped } = await exportMp4({
        bridge, width: W, height: H, fps, duration, audio: mix,
        isCancelled: () => exportCancelled.current,
        lastError: () => runtimeErrorRef.current,
        onProgress: (done, total) => setExportState({ status: `Rendering frame ${done} of ${total}`, progress: done / total, running: true }),
      });
      const name = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "aero-video";
      setExportState({
        status: `Done · ${W}×${H} · ${duration}s · ${(blob.size / 1e6).toFixed(1)} MB${mix ? (audioSkipped ? " · audio left out (this browser can't encode it)" : " · with audio") : ""}`,
        progress: 1, running: false, url: URL.createObjectURL(blob), filename: `${name}.mp4`,
      });
    } catch (err: any) {
      if (err instanceof ExportCancelled) setExportState(null);
      else setExportState((s) => ({ status: `Export failed: ${err?.message || err}`, progress: s?.progress ?? 0, running: false }));
    } finally {
      bridge.setCaptions(null);
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
            <Select<number> showLabel label="Duration" value={project.settings.duration} disabled={!!project.upload}
              title={project.upload ? "The video is as long as your uploaded narration." : undefined}
              onChange={(duration) => changeSettings({ duration })}
              options={(DURATIONS.includes(project.settings.duration) ? DURATIONS : [...DURATIONS, project.settings.duration].sort((a, b) => a - b)).map((d) => ({ value: d, label: `${d}s` }))} />
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
          onScrub={(t) => { pause(); bridge.seek(t); }} segments={segments}
          audio={currentAudio} audioJob={versionJobs[project.current]} muted={audioPrefs.muted}
          onToggleMute={() => setAudioPrefs({ muted: !audioPrefs.muted })}
          onAddAudio={project.versions.length ? () => startAudio(project.id, project.current) : undefined}
          showCaptions={audioPrefs.captions} onToggleCaptions={() => setAudioPrefs({ captions: !audioPrefs.captions })}
          narrationMuted={audioPrefs.narrationMuted} sfxMuted={audioPrefs.sfxMuted}
          onToggleLaneMute={(kind) => setAudioPrefs(kind === "narration" ? { narrationMuted: !audioPrefs.narrationMuted } : { sfxMuted: !audioPrefs.sfxMuted })}
          onEditCaption={editCaption} onRevoiceCaption={revoiceCaption}
          clipLabel={project.versions.length ? `Version ${project.current + 1}` : "Video"} />
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
        onOpenSettings={() => { setSettingsTab("model"); setSettingsOpen(true); }}
        versionAudio={project.versions.map((v) => v.audio)} audioJobs={versionJobs}
        audioAuto={audioPrefs.auto} onAudioAuto={(auto) => setAudioPrefs({ auto })}
        onAudioSettings={() => { setSettingsTab(apiKeys.keys.elevenlabs ? "voice" : "api"); setSettingsOpen(true); }}
        onAddAudio={(vi) => startAudio(project.id, vi)} onCancelAudio={cancelAudio}
        onRemoveAudio={removeAudio} onDismissAudioError={dismissAudioError}
        upload={project.upload} uploadJob={uploadJob?.pid === project.id ? uploadJob : null}
        canAttach={!project.versions.length && !generating} hasElevenKey={!!apiKeys.keys.elevenlabs}
        onAttach={attachAudio} onRemoveUpload={removeUpload} onVoiceover={setVoiceover}
        captionsOn={audioPrefs.captions} onCaptions={(captions) => setAudioPrefs({ captions })}
        onAddElevenKey={() => { setSettingsTab("api"); setSettingsOpen(true); }} />

      {settingsOpen && (
        <SettingsModal user={userState.user} signedIn={userState.signedIn} theme={theme} onTheme={setTheme}
          accent={accent} onAccent={setAccent} model={model} onModel={setModel}
          mode={project.settings.mode} onMode={(mode) => changeSettings({ mode })} effort={effort} onEffort={setEffort} initialTab={settingsTab}
          apiKeys={apiKeys} audioPrefs={audioPrefs} onAudioPrefs={setAudioPrefs}
          onClose={() => setSettingsOpen(false)} />
      )}

      {exportState && (
        <ExportDialog state={exportState} onCancel={() => { exportCancelled.current = true; }} onClose={closeExport} />
      )}
    </div>
  );
}
