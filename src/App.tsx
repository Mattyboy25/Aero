import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantTurn, Attachment, AudioClip, AudioJob, Effort, ModelKey, Overlay, Project, Settings, Aspect } from "./types";
import { ASPECTS, DURATIONS, FPS_OPTIONS, MAX_DURATIONS, MODEL_INFO, dims, fmtTime, titleFrom, uid } from "./lib/constants";
import { planLength } from "./lib/length";
import { writePlan } from "./lib/plan";
import { payload, planIntent } from "./lib/intent";
import { load, newProject, readPref, save, writePref } from "./lib/storage";
import { mergeContinuation, readEvents, splitResponse } from "./lib/stream";
import { RuntimeBridge } from "./lib/runtime";
import { exportMp4, ExportCancelled } from "./lib/exportMp4";
import type { Slosh } from "./lib/slosh";
import { useAccent, useTheme } from "./lib/useTheme";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { CodePane } from "./components/CodePane";
import { PlanPane } from "./components/PlanPane";
import { ExportDialog, type ExportState } from "./components/ExportDialog";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { useUser } from "./lib/user";
import { AudioEngine, blobIdOf, mixdown } from "./lib/audioEngine";
import { MAX_ATTACHMENTS, MAX_IMAGES, fileKind, prepareFile } from "./lib/attachments";
import { DEFAULT_UPLOAD_PROMPT, MAX_UPLOAD_BYTES, MAX_UPLOAD_SECONDS, clipsFromUpload, linesFromWords, looksLikeAudio, transcribe } from "./lib/upload";
import { generateAudio, voiceLine } from "./lib/audioGen";
import { deleteClips, putClip } from "./lib/audioStore";
import { useAudioPrefs, type AudioPrefs } from "./lib/audioPrefs";
import { KEY_HEADERS, useApiKeys } from "./lib/keys";
import { Select } from "./components/Select";
import { IconDownload, IconSidebar } from "./components/Icons";

const IDLE_TEXT = "Your video will appear here";
type Tab = "preview" | "plan" | "code";
/** Requests that mean "I want captions": these are routed to the narration track. */
const CAPTION_REQUEST = /\b(caption(?:s|ed|ing)?|subtitl(?:e|es|ed|ing)|closed[- ]?captions?|voice[- ]?overs?|narrat(?:e|ed|ion|or|ing)|transcripts?)\b/i;
const codeOf = (p: Project) => p.versions[p.current]?.code ?? "";
// A version keeps the length it was made at. The Duration setting only applies to what is made next.
const durationOf = (p: Project) => p.versions[p.current]?.duration ?? p.settings.duration;
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
  const [tab, setTab] = useState<Tab>("preview");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // The tab the app switched to on its own while generating, so it can switch back afterwards
  // (but not if the user picked another tab meanwhile).
  const autoTab = useRef<Tab | null>(null);
  const [livePlan, setLivePlan] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [liveCode, setLiveCode] = useState<string | null>(null);
  // Set once the model starts writing code, which is when a new video's chat slides over to reveal the workspace.
  const [codingStarted, setCodingStarted] = useState(false);
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
  const videoDuration = durationOf(project);
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
      code, W, H, DURATION: durationOf(p), FPS: p.settings.fps,
      t: Math.min(t ?? bridge.getTime(), durationOf(p)), autoplay,
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
    void engine.setClips(currentAudio?.clips ?? [], videoDuration);
  }, [engine, currentAudio, videoDuration]);
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

  // ---------- attachments: images and video the agent looks at ----------
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachBusy, setAttachBusy] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Everything the user picks, drops or pastes comes through here. Images and video become pictures
  // for Claude to look at; an audio recording becomes the narration of a new video.
  async function addFiles(files: File[]) {
    if (!files.length || abortRef.current) return;
    setAttachError(null);
    for (const file of files) {
      const kind = fileKind(file);
      if (kind === "audio") {
        if (projectRef.current.versions.length) { setAttachError("A narration recording can only be added when you start a new video."); continue; }
        await attachAudio(file);
        continue;
      }
      if (kind === "other") { setAttachError(`${file.name} isn't an image, video or audio file.`); continue; }
      const have = attachmentsRef.current;
      if (have.length >= MAX_ATTACHMENTS) { setAttachError(`You can attach up to ${MAX_ATTACHMENTS} images or videos to one message.`); break; }
      setAttachBusy(kind === "video" ? `Looking through ${file.name}…` : `Reading ${file.name}…`);
      try {
        const a = await prepareFile(file);
        const used = attachmentsRef.current.reduce((n, x) => n + x.images.length, 0);
        if (used + a.images.length > MAX_IMAGES) { setAttachError("That's too many pictures for one message. Remove an attachment first."); continue; }
        setAttachments((cur) => (cur.length >= MAX_ATTACHMENTS ? cur : [...cur, a]));
        attachmentsRef.current = [...attachmentsRef.current, a];
      } catch (err: any) {
        setAttachError(err?.message || String(err));
      } finally {
        setAttachBusy(null);
      }
    }
  }
  const removeAttachment = (id: string) => setAttachments((cur) => cur.filter((a) => a.id !== id));

  // ---------- narration upload (new videos) ----------
  const [uploadJob, setUploadJob] = useState<{ pid: string; name: string; status: "decoding" | "transcribing" | "error"; error?: string } | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  // Files that went with a message that was cut off, in case it is continued. Too big to save with the chat.
  const resumeAtts = useRef(new Map<string, Attachment[]>());

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
      const cap = projectRef.current.settings.auto ? projectRef.current.settings.maxDuration : MAX_UPLOAD_SECONDS;
      if (Math.ceil(buf.duration) > cap) throw new Error(`That recording is ${fmtTime(buf.duration)} long, past your ${cap}s max length. Raise the max in the header, or use a shorter recording.`);
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
  // `resumeId`: the id of a reply that was cut off or stopped. It is continued in place, from the code
  // already written, instead of starting a new message.
  // `fromPlan`: build straight from the plan in the Plan tab (`planText`), skipping the chat steps and
  // the plan step: the user has already written or edited the plan.
  async function generate(args: { prompt: string; error?: string; resumeId?: string; fromPlan?: boolean; planText?: string }) {
    const { prompt, resumeId, fromPlan } = args;
    if (abortRef.current) return;
    // Generating needs the user's own Anthropic key; send them to add one.
    const anthropicKey = apiKeys.get("anthropic");
    if (!anthropicKey) { setSettingsTab("api"); setSettingsOpen(true); return; }
    const p = projectRef.current;
    const pid = p.id;
    const prior = resumeId ? p.turns.find((t): t is AssistantTurn => t.role === "assistant" && t.id === resumeId) : undefined;
    const cut = prior?.cutoff;
    if (resumeId && !cut) return;
    // Continuing works on the same code, request and settings the cut-off reply had.
    const error = cut ? cut.error : args.error;
    const startCode = cut ? (cut.baseVersion >= 0 ? p.versions[cut.baseVersion]?.code ?? "" : "") : codeOf(p);
    const baseVersion = cut ? cut.baseVersion : startCode ? p.current : -1;
    const userText = error ? "Fix the error in the current version." : prompt;
    // Files waiting in the composer go with this message, then the composer is empty again.
    const atts = cut ? (resumeAtts.current.get(resumeId!) ?? []) : error ? [] : attachmentsRef.current;
    if (!cut && atts.length) { setAttachments([]); attachmentsRef.current = []; }
    setAttachError(null);
    const isFirst = p.versions.length === 0;
    // Team mode builds new videos; edits and fixes go to the chosen model alone.
    const useTeam = !cut && p.settings.mode === "team" && !startCode && !error;

    const turn: AssistantTurn = cut
      ? { ...prior!, error: undefined, note: undefined, pending: true, phase: "coding" }
      : { id: uid(), role: "assistant", text: "", thinking: "", pending: true, phase: "thinking" };
    if (cut) {
      updateProject(pid, (q) => ({ ...q, turns: q.turns.map((t) => (t.id === turn.id ? { ...turn } : t)) }));
    } else {
      // A new message answers (or moves past) any questions still open.
      updateProject(pid, (q) => ({
        ...q,
        turns: [
          ...q.turns.map((t) => (t.role === "assistant" && t.questions && !t.answered ? { ...t, answered: true } : t)),
          { id: uid(), role: "user", text: userText, ...(atts.length ? { attachments: atts.map(({ kind, name, thumb }) => ({ kind, name, thumb })) } : {}) },
          { ...turn },
        ],
      }));
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setLiveCode(cut ? splitResponse(cut.raw).code || null : null);
    setCodingStarted(!!cut);

    // Stream events arrive faster than the screen refreshes, so push the turn to React once per frame.
    let raf = 0;
    const flush = () => {
      raf = 0;
      const snapshot: AssistantTurn = { ...turn, team: turn.team && { ...turn.team, scenes: turn.team.scenes.map((s) => ({ ...s })) } };
      updateProject(pid, (q) => ({ ...q, turns: q.turns.map((t) => (t.id === turn.id ? snapshot : t)) }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };

    const [width, height] = dims(p.settings);
    let raw = cut ? cut.raw : "";
    let stopReason: string | null = null;
    // When continuing: the code written so far (as the server trimmed it), and what has arrived since.
    let resumeBase: string | null = null;
    let cont = "";
    let request = cut ? cut.request : prompt;
    // The plan the code is written from, and the part of a new plan written so far (kept if stopped).
    let plan = "";
    let planDraft = "";

    try {
      // First work out what the message means. Greetings and questions get a reply, vague requests
      // get a few questions, and only a real request goes on to the animator, as a full brief.
      const uploadStart = isFirst && !!p.upload && prompt === DEFAULT_UPLOAD_PROMPT;
      if (!error && !uploadStart && !cut && !fromPlan) {
        const intent = await planIntent({ message: prompt, turns: p.turns, code: startCode, settings: p.settings, model, key: anthropicKey, signal: controller.signal, attachments: atts });
        if (intent.action === "reply") { turn.text = intent.message; return; }
        if (intent.action === "ask") {
          turn.text = intent.message; turn.questions = intent.questions;
          // The answers are what builds the video, so the files stay in the composer to go with them.
          if (atts.length) { setAttachments((cur) => (cur.length ? cur : atts)); attachmentsRef.current = atts; }
          return;
        }
        request = intent.brief;
      }
      if (p.settings.mode === "team" && !useTeam && !cut) turn.note = `Edits go to ${MODEL_INFO[model].name} directly, so it can see the whole video.`;
      if (useTeam) turn.team = { phase: "planning", scenes: [] };
      schedule();
      setOverlay(useTeam ? `${MODEL_INFO[model].name} is planning the shots…` : cut ? "Claude is picking up where it left off…" : isFirst ? "Claude is thinking…" : "Claude is editing…", true);

      // Auto length: Claude picks how long the video is (within the max) before it is written.
      // An uploaded recording already sets the length, so it skips this.
      let duration = p.settings.duration;
      if (p.settings.auto && !p.upload && !error && !cut && !fromPlan) {
        setOverlay("Choosing the length…", true);
        const plan = await planLength({ prompt: request, current: p.versions.length ? durationOf(p) : undefined, max: p.settings.maxDuration, key: anthropicKey, signal: controller.signal });
        if (plan) {
          duration = plan.seconds;
          turn.note = `${turn.note ? turn.note + " " : ""}Auto length: ${duration}s (max ${p.settings.maxDuration}s).`;
          if (duration !== p.settings.duration) updateProject(pid, (q) => ({ ...q, settings: { ...q.settings, duration } }));
          schedule();
        }
      }
      // The plan step: before any code, Claude writes the plan out in the Plan tab, where it can be
      // read and edited. The code step then implements it instead of planning in hidden thinking.
      // A runtime-error fix skips it (the plan hasn't changed), and so does continuing a cut-off reply.
      plan = fromPlan ? (args.planText ?? p.plan ?? "") : (p.plan ?? "");
      if (!error && !cut && !fromPlan) {
        turn.phase = "planning";
        schedule();
        setOverlay(p.plan ? "Claude is updating the plan…" : "Claude is planning the video…", true);
        setCodingStarted(true); // a new video's workspace slides in, so the plan can be watched
        if (tabRef.current !== "plan") { autoTab.current = "plan"; setTab("plan"); pause(); }
        setLivePlan("");
        plan = await writePlan({
          request, effort, model, key: anthropicKey, signal: controller.signal,
          settings: { width, height, duration, fps: p.settings.fps, animation: p.settings.animation },
          narration: p.upload ? { lines: p.upload.lines } : undefined,
          attachments: payload(atts), currentPlan: p.plan, currentCode: startCode,
          onText: (text) => { planDraft = text; setLivePlan(text); },
        });
        planDraft = "";
        updateProject(pid, (q) => ({ ...q, plan }));
        setLivePlan(null);
        turn.phase = "coding";
        schedule();
        setOverlay(isFirst ? "Claude is writing the code…" : "Claude is editing…", true);
      } else if (fromPlan) {
        updateProject(pid, (q) => ({ ...q, plan }));
        setCodingStarted(true);
      }
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", [KEY_HEADERS.anthropic]: anthropicKey },
        body: JSON.stringify({
          plan: error ? undefined : plan || undefined,
          prompt: error ? "Fix the runtime error so the video plays correctly." : request,
          narration: p.upload ? { lines: p.upload.lines } : undefined,
          attachments: payload(atts),
          code: startCode,
          error: error || "",
          effort,
          model,
          mode: useTeam ? "team" : "solo",
          resume: cut ? { text: cut.raw } : undefined,
          settings: { width, height, duration, fps: p.settings.fps, animation: p.settings.animation },
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
        } else if (event.type === "base") {
          resumeBase = event.text;
          raw = event.text;
        } else if (event.type === "text") {
          if (resumeBase !== null) { cont += event.text; raw = mergeContinuation(resumeBase, cont); } else raw += event.text;
          const { summary, code, inCode } = splitResponse(raw);
          turn.text = summary;
          turn.phase = inCode ? "coding" : "writing";
          if (code) setLiveCode(code);
          if (inCode) setCodingStarted(true);
          if (inCode) setOverlay(`Writing code… ${code.split("\n").length} lines`, true);
        } else if (event.type === "editing") {
          turn.phase = "coding";
          setCodingStarted(true);
          setOverlay("Applying targeted edits…", true);
        } else if (event.type === "retry") {
          // The line edits didn't apply cleanly, so the model is rewriting the whole program instead.
          raw = "";
          turn.text = "";
          turn.note = "Targeted edits didn't apply cleanly, so Claude is rewriting the full program.";
          turn.phase = "thinking";
        } else if (event.type === "fallback") {
          // A fallback model restarts the answer, so drop the partial text.
          raw = resumeBase ?? "";
          cont = "";
          turn.note = `Answered by fallback model ${event.to || ""}`.trim();
        } else if (event.type === "phase" && turn.team) {
          turn.team.phase = event.phase;
          turn.phase = event.phase === "planning" ? "thinking" : "animating";
          if (event.phase !== "planning") setCodingStarted(true);
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
      if (resumeBase !== null) {
        raw = mergeContinuation(resumeBase, cont, true);
        // The model sometimes finishes the program but forgets to close the code block.
        if (stopReason === "end_turn" && splitResponse(raw).code && !splitResponse(raw).complete) raw += "\n```";
      }
      const { code, complete } = splitResponse(raw);
      if (!code || !complete) {
        throw new Error(stopReason === "max_tokens"
          ? "The response was cut off before the code finished."
          : "Claude didn't return any code. Try rephrasing your request.");
      }
      delete turn.cutoff;
      resumeAtts.current.delete(turn.id);

      const latest = projectRef.current;
      // An uploaded recording is the video's narration: the first version gets its clips, and later
      // versions keep whatever the version they were made from has.
      const upAudio = latest.upload
        ? (latest.versions.length ? latest.versions[latest.current]?.audio : { clips: clipsFromUpload(latest.upload), createdAt: Date.now() })
        : undefined;
      const next: Project = {
        ...latest,
        title: isFirst ? titleFrom(latest.upload && prompt === DEFAULT_UPLOAD_PROMPT ? latest.upload.name.replace(/\.[^.]+$/, "") : request) : latest.title,
        versions: [...latest.versions, { code, prompt: error ? userText : request, audio: upAudio, duration, plan: plan || latest.plan }],
        current: latest.versions.length,
      };
      turn.version = next.current;
      updateProject(pid, (q) => ({ ...q, title: next.title, versions: next.versions, current: next.current }));
      if (autoTab.current && tabRef.current === autoTab.current) setTab("preview");
      autoTab.current = null;
      setRuntimeError(null);
      engine.unlock();
      loadPreview(next, true, 0);
      // Captions only ever come from the narration track (the video code is told never to draw them),
      // so a request for captions or a voiceover always gets narration, even with auto audio off.
      const ap = audioPrefsRef.current;
      const wantsCaptions = !error && CAPTION_REQUEST.test(`${prompt}
${request}`);
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
      if (planDraft.trim()) {
        const kept = planDraft;
        updateProject(pid, (q) => ({ ...q, plan: kept }));
        turn.note = "The plan written so far is kept in the Plan tab. Edit it if you like, then build the video from there.";
      }
      autoTab.current = null;
      // Whatever code was written before the failure (a cut-off reply, a stop, a dropped connection)
      // stays, so it can be continued instead of lost.
      const written = splitResponse(raw);
      if (written.code && !written.complete) {
        turn.cutoff = { raw, request, error, baseVersion };
        if (atts.length) resumeAtts.current.set(turn.id, atts);
        switchTab("code");
      }
      if (startCode) hideOverlay(true);
      else setOverlay(IDLE_TEXT, false);
    } finally {
      cancelAnimationFrame(raf);
      delete turn.pending;
      flush();
      abortRef.current = null;
      setGenerating(false);
      setLiveCode(null);
      setLivePlan(null);
    }
  }

  const stop = () => abortRef.current?.abort();
  const savePlan = useCallback((plan: string) => updateProject(projectRef.current.id, (q) => ({ ...q, plan })), [updateProject]);
  const buildFromPlan = (plan: string) => generate({
    prompt: projectRef.current.versions.length ? "Update the video to match the edited plan." : "Build the video from the plan.",
    fromPlan: true, planText: plan,
  });
  const continueTurn = (turnId: string) => generate({ prompt: "", resumeId: turnId });

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
      code: v.code, title: p.title, duration: v.duration ?? p.settings.duration, scenes, previous,
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
      start: Math.min(videoDuration, Math.max(0, patch.start)),
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
    patchClip(pid, vi, id, { id: newId, sourceId: undefined, offset: undefined, source: undefined, text: text.trim(), caption: undefined, duration: buf.duration, start: Math.min(videoDuration, Math.max(0, start)) });
    void deleteClips([id]);
  };
  const versionJobs: Record<number, AudioJob> = {};
  for (const [k, job] of Object.entries(audioJobs)) {
    const at = k.lastIndexOf(":");
    if (k.slice(0, at) === project.id) versionJobs[Number(k.slice(at + 1))] = job;
  }

  // ---------- project actions ----------
  const openProject = (p: Project) => {
    setAttachments([]);
    attachmentsRef.current = [];
    setAttachError(null);
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
    let next = { ...project, settings: { ...project.settings, ...patch } };
    // Pin older versions to the length they have now, so a new Duration only shapes the next version.
    if ("duration" in patch) next = { ...next, versions: next.versions.map((v) => ({ ...v, duration: v.duration ?? project.settings.duration })) };
    updateProject(project.id, () => next);
    if ("aspect" in patch || "fps" in patch) loadPreview(next, playing);
  };

  const restoreVersion = (i: number) => {
    if (abortRef.current) return;
    const next = { ...project, current: i, plan: project.versions[i]?.plan ?? project.plan };
    updateProject(project.id, () => next);
    setRuntimeError(null);
    loadPreview(next, true, 0);
  };

  const runEdits = (code: string) => {
    if (abortRef.current || !code.trim()) return;
    const next: Project = {
      ...project,
      versions: [...project.versions, { code, prompt: "Manual code edit", audio: project.upload ? project.versions[project.current]?.audio : undefined, duration: videoDuration }],
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

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t !== "preview") pause();
  };

  // ---------- export ----------
  const startExport = async () => {
    const [W, H] = dims(project.settings);
    const { fps } = project.settings;
    const duration = videoDuration;
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
  // A new video starts as a full-screen chat. It slides over to show the workspace once the model starts coding.
  // After a cut-off, the Code tab keeps showing what was written, until something newer happens. The
  // workspace stays open for it, even on a video with no finished version yet.
  const lastTurn = project.turns[project.turns.length - 1];
  const cutCode = !generating && lastTurn?.role === "assistant" && lastTurn.cutoff ? splitResponse(lastTurn.cutoff.raw).code : "";
  const focus = project.versions.length === 0 && !(generating && codingStarted) && !cutCode && !project.plan?.trim();
  const [W, H] = dims(project.settings);
  const builtPlan = project.versions[project.current]?.plan;
  const planStatus = livePlan !== null ? "Writing the plan…"
    : !project.plan?.trim() ? "No plan yet"
    : !project.versions.length ? "Not built yet"
    : project.plan === builtPlan ? `Plan for version ${project.current + 1}`
    : "Edited, not built yet";
  const codeStatus = cutCode ? `Cut off · ${cutCode.split("\n").length - 1} lines, not applied`
    : generating && liveCode
    ? `${liveCode.split("\n").length - 1} lines`
    : currentCode ? `Version ${project.current + 1} · ${currentCode.split("\n").length - 1} lines` : "No code yet";

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}${resizing ? " resizing" : ""}${focus ? " focus" : ""}`}
      style={chatW ? ({ "--chat-w": `${chatW}px` } as React.CSSProperties) : undefined}>
      <Sidebar open={sidebarOpen} onToggle={toggleSidebar} projects={projects} activeId={project.id} busy={generating}
        onSelect={selectProject} onNew={createProject} onDelete={deleteProject} theme={theme} onTheme={setTheme}
        userState={userState} onOpenSettings={() => { setSettingsTab("account"); setSettingsOpen(true); }} />

      <main className="workspace" aria-hidden={focus || undefined} inert={focus || undefined}>
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
            {(["preview", "plan", "code"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>
                {t === "preview" ? "Preview" : t === "plan" ? "Plan" : "Code"}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="head-controls">
            <Select<Aspect> showLabel label="Ratio" value={project.settings.aspect} onChange={(aspect) => changeSettings({ aspect })}
              title={`${W}×${H} pixels`}
              options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: a }))} />
            <Select<number> showLabel label="Duration" disabled={!!project.upload}
              value={project.settings.auto && !project.upload ? 0 : project.settings.duration}
              title={project.upload ? "The video is as long as your uploaded narration." : "Auto lets Claude pick the length from your request, up to the max you set."}
              onChange={(d) => (d === 0 ? changeSettings({ auto: true }) : changeSettings({ auto: false, duration: d }))}
              options={[
                { value: 0, label: "Auto", hint: "up to your max" },
                ...(DURATIONS.includes(project.settings.duration) || (project.settings.auto && !project.upload) ? DURATIONS : [...DURATIONS, project.settings.duration].sort((a, b) => a - b)).map((d) => ({ value: d, label: `${d}s` })),
              ]} />
            {project.settings.auto && !project.upload && (
              <Select<number> showLabel label="Max" value={project.settings.maxDuration} title="Auto never goes past this length."
                onChange={(maxDuration) => changeSettings({ maxDuration })}
                options={MAX_DURATIONS.map((d) => ({ value: d, label: `${d}s` }))} />
            )}
            <Select<number> showLabel label="FPS" value={project.settings.fps} onChange={(fps) => changeSettings({ fps })}
              options={FPS_OPTIONS.map((f) => ({ value: f, label: String(f) }))} />
            <button type="button" className="btn primary" onClick={startExport} disabled={!canPlay || generating}>
              <IconDownload width={15} height={15} />Export MP4
            </button>
          </div>
        </header>

        <Preview hidden={tab !== "preview"} bridge={bridge} width={W} height={H}
          duration={videoDuration} fps={project.settings.fps}
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
          clipLabel={project.versions.length ? `Version ${project.current + 1}` : "Video"} code={currentCode} />
        <PlanPane hidden={tab !== "plan"} source={livePlan ?? project.plan ?? ""} streaming={livePlan !== null} generating={generating}
          status={planStatus} hasVideo={project.versions.length > 0}
          canBuild={!!project.plan?.trim() && (!project.versions.length || project.plan !== project.versions[project.current]?.plan)}
          onChange={savePlan} onBuild={buildFromPlan} />
        <CodePane hidden={tab !== "code"} source={liveCode ?? (cutCode || currentCode)} currentCode={currentCode} status={codeStatus}
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
        onRemoveAudio={removeAudio} onDismissAudioError={dismissAudioError} onContinue={continueTurn}
        upload={project.upload} uploadJob={uploadJob?.pid === project.id ? uploadJob : null}
        attachments={attachments} attachBusy={attachBusy} attachError={attachError}
        onFiles={addFiles} onRemoveAttachment={removeAttachment} onDismissAttachError={() => setAttachError(null)}
        onRemoveUpload={removeUpload} onVoiceover={setVoiceover}
        captionsOn={audioPrefs.captions} onCaptions={(captions) => setAudioPrefs({ captions })} />

      {settingsOpen && (
        <SettingsModal user={userState.user} signedIn={userState.signedIn} theme={theme} onTheme={setTheme}
          accent={accent} onAccent={setAccent} model={model} onModel={setModel}
          mode={project.settings.mode} onMode={(mode) => changeSettings({ mode })}
          animation={project.settings.animation} onAnimation={(animation) => changeSettings({ animation })} effort={effort} onEffort={setEffort} initialTab={settingsTab}
          apiKeys={apiKeys} audioPrefs={audioPrefs} onAudioPrefs={setAudioPrefs}
          onClose={() => setSettingsOpen(false)} />
      )}

      {exportState && (
        <ExportDialog state={exportState} onCancel={() => { exportCancelled.current = true; }} onClose={closeExport} />
      )}
    </div>
  );
}
