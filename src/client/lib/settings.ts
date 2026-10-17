// Per-browser preferences. Stored in localStorage when available; the app
// works the same without it (private windows, blocked storage).
import { create } from "zustand";

export interface Settings {
  theme: "system" | "light" | "dark";
  minimap: boolean;
  /**
   * What the mouse wheel / two-finger scroll does on the canvas. "auto":
   * trackpads pan (pinch zooms), a real mouse wheel zooms.
   */
  scrollMode: "auto" | "zoom" | "pan";
  editorFontSize: number;
  /** HTML blocks: live iframe when zoomed in (auto), always, or never (placeholder only). */
  htmlPreviews: "auto" | "always" | "never";
  confirmDelete: boolean;
  /** Mode a block you create yourself opens in. */
  newBlockMode: "raw" | "rendered";
  chatWidth: number;
  showGrid: boolean;
  /** While the agent works, glide the camera to the block it is editing. */
  followAgent: boolean;
  /** The left panel: which tab, and whether it is open. */
  sidePanel: "outline" | "views" | "slides" | "comments" | "readme" | "history";
  sidePanelOpen: boolean;
  sidePanelWidth: number;
  /** Bumped when a default changes in a way stored preferences should pick up. */
  settingsVersion: number;
}

const DEFAULTS: Settings = {
  theme: "system",
  minimap: true,
  scrollMode: "auto",
  editorFontSize: 13,
  htmlPreviews: "auto",
  confirmDelete: false,
  newBlockMode: "raw",
  chatWidth: 420,
  showGrid: true,
  followAgent: false,
  sidePanel: "outline",
  sidePanelOpen: false,
  sidePanelWidth: 340,
  settingsVersion: 2,
};

const KEY = "think.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>;
      // v1 stored every preference, so "zoom" there was the old default rather
      // than a choice: move it to the new "auto".
      if ((stored.settingsVersion ?? 1) < 2 && stored.scrollMode === "zoom") stored.scrollMode = "auto";
      return { ...DEFAULTS, ...stored, settingsVersion: DEFAULTS.settingsVersion };
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

interface SettingsStore extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsStore>);
    persist(get());
  },
  reset: () => {
    set({ ...DEFAULTS });
    persist(get());
  },
}));

function persist(s: SettingsStore): void {
  const out: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) (out as Record<string, unknown>)[k] = s[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* storage unavailable */
  }
}

/** Resolve "system" against the OS preference. */
export function effectiveTheme(theme: Settings["theme"]): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Small per-project UI memory (e.g. which blocks are in raw mode). */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
