// What kind of screen and pointer we are on — for the phone layout and touch.
//
//   phone   up to 640 px wide: reading, getting around, chat, comments and
//           light text edits; precise work says "use a tablet or computer".
//   narrow  up to 900 px: the side panel closes after a jump (it would
//           otherwise cover what you jumped to).
//   touch   a coarse pointer: one finger pans the canvas (no box-select).
import { useSyncExternalStore } from "react";

export const PHONE = "(max-width: 640px)";
export const NARROW = "(max-width: 900px)";
export const TOUCH = "(pointer: coarse)";

export function matches(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matches(query),
    () => false,
  );
}

export const isPhone = () => matches(PHONE);
