export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export type Effort = "low" | "medium" | "high";
export type Engine = "solo" | "team";
export type AnimationStyle = "auto" | "minimal" | "smooth" | "kinetic" | "playful" | "cinematic" | "storytelling" | "immersive";
export type ModelKey = "opus" | "sonnet" | "haiku";
export type Theme = "light" | "dark" | "system";
export type Accent = "terracotta" | "blue" | "violet" | "green" | "rose" | "amber";

export interface Settings {
  aspect: Aspect;
  duration: number;
  fps: number;
  mode: Engine;
  /** Let Claude pick the length from the request, never past `maxDuration`. */
  auto: boolean;
  maxDuration: number;
  /** How things animate. Sent to the model as direction for every shot. */
  animation: AnimationStyle;
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

export type Phase = "thinking" | "planning" | "writing" | "coding" | "animating";

export interface UserTurn {
  id: string;
  role: "user";
  text: string;
  /** Files sent with this message, as small previews for the chat. */
  attachments?: AttachmentMeta[];
}

/** What the chat remembers about a file the user attached to a message. */
export interface AttachmentMeta {
  kind: "image" | "video";
  name: string;
  /** A small JPEG data URL. */
  thumb: string;
}

/** A picture, or video frames, ready to send to Claude with the next message. */
export interface Attachment extends AttachmentMeta {
  id: string;
  /** Seconds, for videos. */
  duration?: number;
  /** The pictures themselves: one for an image, several sampled frames for a video. */
  images: { mediaType: string; data: string }[];
}

/** A question the assistant asks before building, shown in the picker above the composer. */
export interface Question {
  /** Short tab label, one or two words. */
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
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
  /** Code that was written before the reply was cut off or stopped, kept so it can be continued. */
  cutoff?: { raw: string; request: string; error?: string; baseVersion: number };
  /** Questions asked before building. `answered` is set once the user replies or skips. */
  questions?: Question[];
  answered?: boolean;
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
  /** Length of this version in seconds, fixed when it was made. Older saves fall back to the project's setting. */
  duration?: number;
  /** The plan this version was built from. */
  plan?: string;
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
  /** The plan the code is written from: written by Claude before any code, editable by the user. */
  plan?: string;
}

export interface Overlay {
  visible: boolean;
  busy: boolean;
  fading: boolean;
  text: string;
}
