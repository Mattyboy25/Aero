import { useCallback, useState } from "react";

// What to generate, and how loud each lane plays. Saved in this browser.
export interface AudioPrefs {
  /** Generate narration and sound right after each new version of the video. */
  auto: boolean;
  narration: boolean;
  sfx: boolean;
  voiceId: string;
  voiceName: string;
  /** 0..100 */
  narrationVolume: number;
  sfxVolume: number;
  muted: boolean;
  /** Show narration captions over the preview. */
  captions: boolean;
  /** Per-lane mutes from the timeline. They apply to playback and export. */
  narrationMuted: boolean;
  sfxMuted: boolean;
}

export const DEFAULT_VOICE = { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" };

const KEY = "aero.audio";
const DEFAULTS: AudioPrefs = {
  auto: false, narration: true, sfx: true, voiceId: DEFAULT_VOICE.id, voiceName: DEFAULT_VOICE.name,
  narrationVolume: 90, sfxVolume: 60, muted: false, captions: true, narrationMuted: false, sfxMuted: false,
};

function read(): AudioPrefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return DEFAULTS; }
}

export function useAudioPrefs(): [AudioPrefs, (patch: Partial<AudioPrefs>) => void] {
  const [prefs, setPrefs] = useState(read);
  const update = useCallback((patch: Partial<AudioPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return [prefs, update];
}
