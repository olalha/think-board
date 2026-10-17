import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { closeProject, openProject, saveCanvas } from "../lib/project";
import { fitPanels, setChatOpen, setSidePanelOpen, useBoard } from "../lib/store";
import { isPhone } from "../lib/device";
import { BoardCanvas } from "../canvas/BoardCanvas";
import { ChatPanel } from "../chat/ChatPanel";
import { LoginDialog } from "../chat/LoginDialog";
import { TopBar } from "../components/TopBar";
import { ConnectionBanner, LockBanner, ProblemsBanner } from "../components/Banners";
import { DialogHost } from "../components/Dialogs";
import { Palette } from "../components/Palette";
import { CommentsPopover } from "../components/Comments";
import { DiffDialog, SidePanel, TimeTravelBar } from "../components/SidePanel";
import { useSettings } from "../lib/settings";
import { PresentBar, startPresenting, usePresent } from "../components/Present";
import { useCanvasUi } from "../canvas/ui-state";
import { goToView, saveViewSlot } from "../canvas/actions";
import { isMac } from "../lib/keys";

export function Board({ slug }: { slug: string }) {
  useEffect(() => {
    openProject(slug);
    return () => {
      useBoard.setState({ timeTravel: null });
      closeProject();
    };
  }, [slug]);

  useEffect(() => {
    // A phone opens on the canvas itself, not on a panel covering it.
    if (isPhone()) setSidePanelOpen(false);
    document.documentElement.classList.add("on-board");
    // Side panel and chat side by side only where both fit next to the canvas.
    fitPanels();
    window.addEventListener("resize", fitPanels);
    return () => {
      document.documentElement.classList.remove("on-board");
      window.removeEventListener("resize", fitPanels);
    };
  }, []);

  // Warm the editor chunk once the board is idle, so the first edit is instant.
  useEffect(() => {
    const t = setTimeout(() => void import("../blocks/CodeEditor"), 2500);
    return () => clearTimeout(t);
  }, []);

  const loaded = useBoard((s) => s.loaded);
  const conn = useBoard((s) => s.conn);
  const chatOpen = useBoard((s) => s.chatOpen);
  const sideOpen = useSettings((s) => s.sidePanelOpen);
  const timeTravel = useBoard((s) => !!s.timeTravel);

  // ⌘K quick jump and ⌘S save work everywhere, editors included — so they
  // listen in the capture phase, before an editor can keep the key to itself.
  useEffect(() => {
    const onModKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        useCanvasUi.setState((s) => ({ palette: !s.palette }));
      } else if (k === "s") {
        e.preventDefault(); // not the browser's "Save page as…"
        if (!e.repeat) void saveCanvas();
      }
    };
    window.addEventListener("keydown", onModKey, { capture: true });
    return () => window.removeEventListener("keydown", onModKey, { capture: true });
  }, []);

  // Board-wide keys: C chat, B side panel, P present, 1–9 saved views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest(".cm-editor, .drawing-editor, .drawing-toolbar")) return;
      if (document.querySelector(".overlay, .menu") || usePresent.getState().active) return;
      // Views by the physical key, so 1–9 work on any keyboard layout (and with Shift).
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit) {
        e.preventDefault();
        if (e.shiftKey) void saveViewSlot(Number(digit));
        else {
          const v = useBoard.getState().canvas.views?.[Number(digit) - 1];
          if (v) goToView(v);
        }
        return;
      }
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setChatOpen(!useBoard.getState().chatOpen);
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        setSidePanelOpen(!useSettings.getState().sidePanelOpen);
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        startPresenting();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ReactFlowProvider>
      <div className={`board ${chatOpen ? "chat-open" : ""} ${sideOpen ? "side-open" : ""} ${timeTravel ? "time-travel" : ""}`}>
        <TopBar />
        <SidePanel />
        <main className="board-main">
          {loaded && conn !== "failed" && <BoardCanvas />}
          <LockBanner />
          <ProblemsBanner />
          <ConnectionBanner />
        </main>
        <ChatPanel />
        <LoginDialog />
        <DialogHost inBoard />
        <CommentsPopover />
        <Palette />
        <TimeTravelBar />
        <DiffDialog />
        <PresentBar />
      </div>
    </ReactFlowProvider>
  );
}
