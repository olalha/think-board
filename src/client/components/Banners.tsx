// Board-level status banners: the agent lock, the connection, and canvas problems.
import { useState } from "react";
import { AlertTriangle, ArrowLeft, Bot, Square, WifiOff } from "lucide-react";
import { act } from "../lib/project";
import { navigate } from "../lib/router";
import { useBoard } from "../lib/store";

export function LockBanner() {
  const lock = useBoard((s) => s.lock);
  const running = useBoard((s) => s.turnRunning);
  const guest = lock.locked && lock.reason === "guest";
  return (
    <div className={`lock-banner ${lock.locked ? "show" : ""} ${guest ? "guest" : ""}`} aria-live="polite">
      {guest ? <Bot size={14} /> : <span className="typing small"><i /><i /><i /></span>}
      <span>
        {guest ? (
          <>
            <b>{lock.by}</b> is working on this canvas{lock.note ? ` — ${lock.note}` : ""}
          </>
        ) : (
          "Agent is working — editing is paused"
        )}
      </span>
      {running && !guest && (
        <button className="btn small" onClick={() => void act({ type: "agent.cancel" })}>
          <Square size={11} fill="currentColor" /> Stop
        </button>
      )}
      {guest && (
        <button
          className="btn small"
          title="End the outside agent's lock now; its edits so far are committed under its name."
          onClick={() => void act({ type: "guest.takeover" })}
        >
          Take over
        </button>
      )}
    </div>
  );
}

export function ConnectionBanner() {
  const conn = useBoard((s) => s.conn);
  const loaded = useBoard((s) => s.loaded);
  const detail = useBoard((s) => s.connDetail);
  if (conn === "failed") {
    return (
      <div className="center-state">
        <div className="center-card">
          <AlertTriangle size={22} />
          <h2>This canvas can't be opened</h2>
          <p>{detail ?? "It may have been removed."}</p>
          <button className="btn" onClick={() => navigate("/")}>
            <ArrowLeft size={14} /> All canvases
          </button>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="center-state">
        <span className="spinner large" />
      </div>
    );
  }
  if (conn === "reconnecting" || conn === "connecting") {
    return (
      <div className="conn-banner">
        <WifiOff size={14} /> Connection lost — reconnecting… Your edits are kept and sent when it's back.
      </div>
    );
  }
  return null;
}

export function ProblemsBanner() {
  const canvasError = useBoard((s) => s.canvasError);
  const conflicts = useBoard((s) => s.conflicts);
  const validation = useBoard((s) => s.validation);
  const [open, setOpen] = useState(false);
  const loose = (validation?.final ? validation.issues : []).filter((i) => !i.block);
  const problems: string[] = [];
  if (canvasError) problems.push(`${canvasError}\nThe canvas shows the last valid layout until it is fixed.`);
  problems.push(...conflicts);
  for (const i of loose) if (!canvasError || !i.message.includes("canvas.json")) problems.push(`${i.file ?? "project"}: ${i.message}`);
  if (!problems.length) return null;
  const headline = canvasError ? "canvas.json is invalid — showing the last valid layout" : problems.length === 1 ? problems[0].split("\n")[0] : `${problems.length} problems in this canvas`;
  return (
    <div className="problems-banner">
      <button className="problems-head" onClick={() => setOpen(!open)}>
        <AlertTriangle size={14} />
        <span className="problems-text">{headline}</span>
        <span className="link-btn">{open ? "Hide" : "Details"}</span>
      </button>
      {open && (
        <div className="problems-body">
          {problems.map((p, i) => (
            <pre key={i}>{p}</pre>
          ))}
          <div className="muted small">Ask the agent to fix these, or fix them by hand.</div>
        </div>
      )}
    </div>
  );
}
