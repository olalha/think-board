// Fitting the app to what a phone or tablet actually shows.
//
//   - The app is as tall as the visible area (--app-h), not the layout
//     viewport: iOS browsers lay the page out taller than what sits between
//     the status bar and the toolbar, and with the on-screen keyboard open the
//     visible area shrinks to what is above it. So the chat's header stays in
//     view and its text box sits right on the keyboard.
//   - iOS scrolls the whole page to bring a text field into view, and can leave
//     it scrolled after the keyboard closes, with the top of the app out of
//     reach. The app always fits, so the page goes straight back to the top.
//   - iOS zooms into any text field with text under 16px when it gets focus.
//     maximum-scale=1 stops that there (and iOS still lets people pinch-zoom);
//     other browsers would take it as "no pinch-zoom", so they don't get it.
import { TOUCH, matches } from "./device";

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function setupViewport(): void {
  if (isIOS()) {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta && !meta.content.includes("maximum-scale")) meta.content += ", maximum-scale=1";
  }
  const vv = window.visualViewport;
  if (!vv || !matches(TOUCH)) return;
  const root = document.documentElement;
  root.classList.add("fit-visible");
  let raf = 0;
  const fit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (vv.scale > 1.02) return; // pinch-zoomed into the page: leave it be
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      // Where the visible area is within the page (iOS may still pan it).
      root.style.setProperty("--app-top", `${Math.max(0, Math.round(vv.offsetTop))}px`);
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    });
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  window.addEventListener("scroll", fit, { passive: true });
  // After the keyboard closes (a field loses focus), check once it has settled.
  document.addEventListener("focusout", () => setTimeout(fit, 120));
  fit();
}
