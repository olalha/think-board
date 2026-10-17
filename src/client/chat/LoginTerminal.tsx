// The provider login terminal: the agent's own advertised login command,
// running in a PTY on the server inside the provider's isolated home,
// streamed here into xterm.js.
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { CheckCircle2, ExternalLink, KeyRound, X } from "lucide-react";
import { send } from "../lib/project";
import { useBoard } from "../lib/store";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

// Loaded on demand by LoginDialog: xterm.js is only needed while logging in.
export default function LoginDialogInner() {
  const output = useBoard((s) => s.loginOutput);
  const exit = useBoard((s) => s.loginExit);
  const provider = useBoard((s) => s.project?.provider.label ?? "the agent");
  const agentReady = useBoard((s) => s.agent.state === "ready");
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const written = useRef(0);
  const [code, setCode] = useState("");

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 2000,
      theme: { background: "#141413", foreground: "#e8e8e4", cursor: "#9b9bff", selectionBackground: "#3b3b6b" },
      linkHandler: { activate: (_e, uri) => window.open(uri, "_blank", "noopener") },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    fit.fit();
    term.current = t;
    written.current = 0;
    const s = useBoard.getState();
    if (s.loginOutput) {
      t.write(s.loginOutput);
      written.current = s.loginOutput.length;
    }
    if (s.loginRequest) {
      send({ type: "login.start", methodId: s.loginRequest, cols: t.cols, rows: t.rows });
      useBoard.setState({ loginRequest: null });
    }
    const data = t.onData((d) => send({ type: "login.input", data: d }));
    const ro = new ResizeObserver(() => {
      fit.fit();
      send({ type: "login.resize", cols: t.cols, rows: t.rows });
    });
    ro.observe(host.current!);
    t.focus();
    return () => {
      data.dispose();
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (output.length < written.current) {
      t.reset();
      written.current = 0;
    }
    t.write(output.slice(written.current));
    written.current = output.length;
  }, [output]);

  const url = useMemo(() => {
    const plain = output.replace(ANSI, "");
    return /https:\/\/[^\s"'<>]+/.exec(plain)?.[0] ?? null;
  }, [output]);

  const close = () => useBoard.setState({ loginOpen: false });
  const cancel = () => {
    if (exit === undefined) send({ type: "login.stop" });
    close();
  };
  const done = exit !== undefined;
  const success = done && (exit === 0 || agentReady);

  useEffect(() => {
    if (success && agentReady) {
      const t = setTimeout(close, 1600);
      return () => clearTimeout(t);
    }
  }, [success, agentReady]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !done && undefined}>
      <div className="dialog wide login-dialog" role="dialog" aria-label={`Log in to ${provider}`}>
        <div className="dialog-head">
          <KeyRound size={18} />
          <h2>Log in to {provider}</h2>
          <button className="icon-btn" aria-label="Close" onClick={cancel}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <ol className="login-steps">
            <li>
              Open the login page and approve access.
              {url && (
                <a className="btn primary small" href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={13} /> Open login page
                </a>
              )}
            </li>
            <li>
              Copy the code it shows, paste it here, press Enter.
              <form
                className="login-code"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!code.trim()) return;
                  send({ type: "login.input", data: code.trim() + "\r" });
                  setCode("");
                }}
              >
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" disabled={done} autoComplete="off" spellCheck={false} />
                <button className="btn" disabled={done || !code.trim()}>Submit</button>
              </form>
            </li>
          </ol>
          <div className="login-term" ref={host} />
          {done && (
            <div className={`login-result ${success ? "ok" : "fail"}`}>
              {success ? (
                <>
                  <CheckCircle2 size={16} /> {agentReady ? "Logged in — the agent is ready." : "Login finished. Starting the agent…"}
                </>
              ) : (
                <>The login command exited (code {exit ?? "?"}). Scroll up in the terminal for details, then try again.</>
              )}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <span className="muted small grow">Runs the provider's own login in its isolated home on the server.</span>
          <button className="btn" onClick={cancel}>{done ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
