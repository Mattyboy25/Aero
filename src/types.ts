export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export type Effort = "low" | "medium" | "high";
export type Engine = "solo" | "team";
export type ModelKey = "opus" | "sonnet" | "haiku";
export type Theme = "light" | "dark" | "system";
export type Accent = "terracotta" | "blue" | "violet" | "green" | "rose" | "amber";

export interface Settings {
  aspect: Aspect;
  duration: number;
  fps: number;
  mode: Engine;
}

export type SceneStatus = "waiting" | "writing" | "retrying" | "done" | "failed";

export interface Scene {
  start: number;
  end: number;
  title: string;
  status: SceneStatus;
  lines: number;
  error?: string;
}

export type Phase = "thinking" | "writing" | "coding" | "animating";

export interface UserTurn {
  id: string;
  role: "user";
  text: string;
}

export interface AssistantTurn {
  id: string;
  role: "assistant";
  text: string;
  thinking: string;
  pending?: boolean;
  phase?: Phase;
  note?: string;
  error?: string;
  version?: number;
  team?: { phase: string; scenes: Scene[] };
}

export type Turn = UserTurn | AssistantTurn;

export type ClipKind = "narration" | "sfx";

/** One piece of audio on the timeline. The sound itself is stored in IndexedDB under `id`. */
export interface AudioClip {
  id: string;
  kind: ClipKind;
  /** Seconds from the start of the video. */
  start: number;
  /** Measured length of the generated audio, in seconds. */
  duration: number;
  /** The spoken line, or the sound effect's description. */
  text: string;
  /** Narration only: caption text when it was edited to differ from what the voice says. */
  caption?: string;
  /** 0..1, relative to its lane's volume. */
  volume: number;
  /**
   * Clips cut from an uploaded recording share one stored copy of it (under this id) and each
   * play a slice, starting `offset` seconds in. Other clips are stored under their own `id`.
   */
  sourceId?: string;
  offset?: number;
  source?: "upload";
}

/** One spoken line of a transcript, in seconds. */
export interface SpokenLine { start: number; end: number; text: string }

/** A narration recording the user uploaded for a new video. The audio is in IndexedDB under `sourceId`. */
export interface Upload {
  sourceId: string;
  name: string;
  /** Length of the recording, in seconds. */
  duration: number;
  lines: SpokenLine[];
  language?: string | null;
  /** Play the recording as the video's voice over. Off means it only shapes the video and its captions. */
  voiceover: boolean;
}

export interface VersionAudio {
  clips: AudioClip[];
  voiceId?: string;
  createdAt: number;
  /** Parts of the plan that couldn't be generated. */
  skipped?: number;
}

export interface Version {
  code: string;
  prompt: string;
  audio?: VersionAudio;
}

/** Progress of a narration/sound job, kept in memory only. */
export interface AudioJob {
  stage: "planning" | "generating" | "done" | "error";
  done: number;
  total: number;
  error?: string;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  settings: Settings;
  turns: Turn[];
  versions: Version[];
  current: number;
  /** A recording uploaded when the video was started. It sets the video's length and drives its animation. */
  upload?: Upload;
}

export interface Overlay {
  visible: boolean;
  busy: boolean;
  fading: boolean;
  text: string;
}
