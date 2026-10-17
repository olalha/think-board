import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  action?: { label: string; run: () => void };
  leaving?: boolean;
  /** A toast with the same key replaces the previous one (e.g. repeated ⌘Z). */
  key?: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ms?: number) => number;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t, ms = t.kind === "error" ? 6000 : 3500) => {
    const id = ++seq;
    const kept = t.key ? get().toasts.filter((x) => x.key !== t.key) : get().toasts;
    set({ toasts: [...kept.slice(-3), { ...t, id }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => {
    if (!get().toasts.some((t) => t.id === id && !t.leaving)) return;
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 180);
  },
}));

export const toast = {
  info: (text: string, action?: Toast["action"], ms?: number) => useToasts.getState().push({ kind: "info", text, action }, ms),
  success: (text: string, action?: Toast["action"], ms?: number) => useToasts.getState().push({ kind: "success", text, action }, ms),
  error: (text: string, ms?: number) => useToasts.getState().push({ kind: "error", text }, ms),
  /** One line that updates in place rather than stacking up. */
  status: (key: string, text: string, ms = 1800) => useToasts.getState().push({ kind: "info", text, key }, ms),
};
