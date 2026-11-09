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

export interface Version {
  code: string;
  prompt: string;
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
}

export interface Overlay {
  visible: boolean;
  busy: boolean;
  fading: boolean;
  text: string;
}
