// A tiny pathname router — three routes don't need a library.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "list" }
  | { name: "board"; slug: string }
  | { name: "render"; slug: string; block: string }
  | { name: "notfound" };

const SEG = "([a-z0-9]+(?:-[a-z0-9]+)*)";

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "list" };
  let m = new RegExp(`^/p/${SEG}/?$`).exec(pathname);
  if (m) return { name: "board", slug: m[1] };
  m = new RegExp(`^/render/${SEG}/${SEG}/?$`).exec(pathname);
  if (m) return { name: "render", slug: m[1], block: m[2] };
  return { name: "notfound" };
}

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
  return parseRoute(path);
}
