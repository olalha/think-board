// Board/list dialogs: help & shortcuts, settings (+ server info), confirm, block issues.
import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleSlash, HelpCircle, KeyRound, Search, Settings, X } from "lucide-react";
import { displayName } from "../../shared/blocks";
import { AUTOSAVE_CHOICES } from "../../shared/protocol";
import { getJSON, setProviderAuth, type ServerInfo } from "../lib/api";
import { toast } from "../lib/toasts";
import { modLabel } from "../lib/keys";
import { matches, TOUCH } from "../lib/device";
import { useSettings, type Settings as S } from "../lib/settings";
import { act } from "../lib/project";
import { useBoard } from "../lib/store";
import { useCanvasUi } from "../canvas/ui-state";

export function Dialog({ title, icon, onClose, children, footer, wide, tall }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; tall?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""} ${tall ? "tall" : ""}`} role="dialog" aria-label={title}>
        <div className="dialog-head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- global dialog host

export function DialogHost({ inBoard }: { inBoard: boolean }) {
  const dialog = useCanvasUi((s) => s.dialog);
  const setDialog = useCanvasUi((s) => s.setDialog);
  const confirm = useCanvasUi((s) => s.confirm);
  const issues = useCanvasUi((s) => s.issues);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest(".cm-editor")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setDialog("settings");
      } else if (e.key === "?" && !document.querySelector(".overlay")) {
        e.preventDefault();
        setDialog("help");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setDialog]);

  return (
    <>
      {dialog === "help" && <HelpDialog inBoard={inBoard} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog inBoard={inBoard} onClose={() => setDialog(null)} />}
      {confirm && <ConfirmDialog />}
      {issues && (
        <Dialog title={`Problems in ${displayName(issues.id)}`} icon={<AlertCircle size={18} className="danger-text" />} onClose={() => useCanvasUi.getState().hideIssues()}>
          <pre className="issues-pre">{issues.text}</pre>
          <p className="muted small">The agent is told about validation errors automatically after its turn. You can also ask it to fix them.</p>
        </Dialog>
      )}
    </>
  );
}

function ConfirmDialog() {
  const c = useCanvasUi((s) => s.confirm)!;
  const close = useCanvasUi((s) => s.closeConfirm);
  return (
    <Dialog
      title={c.title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          {c.alt && (
            <button
              className={`btn ${c.alt.danger ? "danger" : ""}`}
              onClick={() => {
                close();
                c.alt!.run();
              }}
            >
              {c.alt.action}
            </button>
          )}
          <button
            className={`btn ${c.danger ? "danger solid" : "primary"}`}
            autoFocus
            onClick={() => {
              close();
              c.run();
            }}
          >
            {c.action}
          </button>
        </>
      }
    >
      <p className="muted">{c.body}</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------- help

type Shortcut = [keys: string[], what: string];
type ShortcutGroup = { group: string; note?: string; items: Shortcut[] };

const M = modLabel;
/** Grouped by what you are doing; the action first, the keys after. */
const SHORTCUTS: ShortcutGroup[] = [
  {
    group: "Get around",
    items: [
      [[M, "K"], "Quick jump to a block, view or action"],
      [["Space", "Drag"], "Pan (or two-finger scroll, middle-drag)"],
      [[M, "Scroll"], "Zoom (a mouse wheel or a pinch zooms too)"],
      [["F"], "Fit everything in view"],
      [["Z"], "Zoom to the selection"],
      [["0"], "Zoom to 100%"],
      [["Double-click"], "On a title bar or frame name: zoom to it"],
      [["Alt", "←"], "Back to where you were (Alt → forward)"],
      [["1–9"], "Go to a saved view"],
      [["Shift", "1–9"], "Save the selection (or screen) as a view"],
      [["P"], "Present the saved views"],
    ],
  },
  {
    group: "Add",
    items: [
      [["M"], "Markdown note"],
      [["D"], "Mermaid diagram"],
      [["H"], "HTML block"],
      [["I"], "Image (or paste or drop one)"],
      [["S"], "Blank page to draw on"],
      [["G"], "Frame around the selection"],
    ],
  },
  {
    group: "Select and arrange",
    items: [
      [["Drag"], "Select in a box (from empty canvas)"],
      [["Shift", "Click"], "Add to the selection"],
      [[M, "A"], "Select all"],
      [["←↑→↓"], "Nudge the selection"],
      [["F2"], "Rename"],
      [["Del"], "Delete"],
    ],
  },
  {
    group: "Edit a block",
    items: [
      [["Enter"], "Edit it (an image: draw on it)"],
      [["Esc"], "Back to the preview"],
      [[M, "Enter"], "Switch edit / preview"],
      [["R"], "Every block back to its preview"],
      [["Alt", "Z"], "Wrap long lines (in the editor)"],
    ],
  },
  {
    group: "Undo, copy, save",
    items: [
      [[M, "Z"], "Undo (in an editor: typing)"],
      [[M, "Shift", "Z"], M === "⌘" ? "Redo" : "Redo (or Ctrl Y)"],
      [[M, "C"], "Copy (also into another canvas)"],
      [[M, "X"], "Cut"],
      [[M, "V"], "Paste blocks, an image or text"],
      [[M, "D"], "Duplicate"],
      [[M, "S"], "Save now: a point in History"],
    ],
  },
  {
    group: "Drawing",
    note: "while drawing on an image",
    items: [
      [["V"], "Select; drag a box for several"],
      [["P"], "Pen"],
      [["H"], "Highlighter"],
      [["A"], "Arrow"],
      [["L"], "Line"],
      [["R"], "Rectangle"],
      [["O"], "Ellipse"],
      [["T"], "Text"],
      [["E"], "Eraser (again: strokes / rub out)"],
      [["C"], "Crop and rotate"],
      [["1", "2", "3"], "Small, medium, large"],
      [[M, "A"], "Select everything"],
      [["Del"], "Delete the selection"],
      [["Esc"], "Done"],
    ],
  },
  {
    group: "Chat and agent",
    items: [
      [["C"], "Show / hide the chat"],
      [["/"], "Type to the agent"],
      [["/clear"], "Start a new conversation"],
      [["@"], "Mention a block"],
      [["A"], "Ask about the selection"],
      [["Enter"], "Send (Shift Enter: new line)"],
      [["↑"], "Your previous message"],
    ],
  },
  {
    group: "App",
    items: [
      [["B"], "Show / hide the side panel"],
      [["?"], "This help"],
      [[M, ","], "Settings"],
    ],
  },
];

const GESTURES: Shortcut[] = [
  [["Swipe"], "Pan — also when it starts on a block"],
  [["Pinch"], "Zoom"],
  [["Tap"], "Select a block; then a swipe scrolls what's in it"],
  [["Title bar"], "Tablet: drag a selected block by it to move it"],
  [["···"], "A block's menu: rename, replace, delete…"],
  [["Phone"], "The layout stays put: read, chat, comment, light edits"],
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="help-keys">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

function HelpDialog({ onClose, inBoard }: { onClose: () => void; inBoard: boolean }) {
  const touch = matches(TOUCH);
  const [tab, setTab] = useState<"keys" | "touch" | "about">(touch ? "touch" : "keys");
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  // What the rows say or their keys; a group's name brings the whole group when no row matches.
  const groups = SHORTCUTS.map((g) => {
    if (!needle) return g;
    const items = g.items.filter(([keys, what]) => what.toLowerCase().includes(needle) || keys.join(" ").toLowerCase() === needle);
    return { ...g, items: items.length || !g.group.toLowerCase().includes(needle) ? items : g.items };
  }).filter((g) => g.items.length);
  return (
    <Dialog title="Shortcuts & help" icon={<HelpCircle size={18} />} onClose={onClose} wide tall>
      <div className="help-top">
        <div className="segmented" role="tablist">
          {(
            [
              ["keys", "Keyboard"],
              ["touch", "Touch"],
              ["about", "How it works"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "keys" && (
          <label className="help-find">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a shortcut" autoFocus={!touch} aria-label="Find a shortcut" />
          </label>
        )}
      </div>
      {tab === "keys" && (
        <div className="help-cols">
          {groups.map((g) => (
            <section key={g.group} className="help-group">
              <h3>
                {g.group}
                {g.note && <span className="help-note">{g.note}</span>}
              </h3>
              {g.items.map(([keys, what]) => (
                <div key={g.group + what} className="help-row">
                  <span className="help-what">{what}</span>
                  <Keys keys={keys} />
                </div>
              ))}
            </section>
          ))}
          {!groups.length && <p className="side-empty">No shortcut matches “{q.trim()}”.</p>}
        </div>
      )}
      {tab === "touch" && (
        <section className="help-group help-touch">
          {GESTURES.map(([keys, what]) => (
            <div key={what} className="help-row">
              <span className="help-what">{what}</span>
              <Keys keys={keys} />
            </div>
          ))}
        </section>
      )}
      {tab === "about" && (
        <section className="help-about">
          <ul>
            <li><b>Every block is a file</b> in the canvas's folder — <code>harry.md</code> is the block “Harry”. The layout is <code>canvas.json</code>.</li>
            <li><b>Each canvas has its own agent.</b> Ask it in the chat; it edits the files directly and the canvas updates live. Refer to blocks by name.</li>
            <li><b>One editor at a time.</b> While the agent works, editing pauses (you can still pan, zoom and read). Your edits are committed to the canvas's git history before each message.</li>
            <li><b>Other agents can join.</b> An agent on this machine (Claude Code in a terminal, Codex…) can work on a canvas with the <code>think</code> command. While it is here it has a tab in the chat, its edits are ringed with its name, and History keeps them under it. It can't read replies in think — answer it where you usually talk to it.</li>
            <li><b>Groups and views.</b> Frame related blocks with <kbd>G</kbd>; dragging a frame carries its blocks. Save viewpoints in the side panel and present them with <kbd>P</kbd>.</li>
            <li><b>Rename</b> a block with the pencil next to its name (or <kbd>F2</kbd>); its connections follow.</li>
            <li><b>Edit and preview.</b> Edit the raw text; the preview is read-only. Markdown can show canvas images with <code>![](sally.png)</code>.</li>
            <li><b>Images</b> can be drawn on (<kbd>Enter</kbd>), or start as a blank page (<kbd>S</kbd>). History keeps every version.</li>
            {inBoard && <li><b>Connect blocks</b> by dragging from the dots on any side. Right-click a connection for arrowheads and labels, or click its middle dot to label it.</li>}
          </ul>
        </section>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <div>{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled = [] }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: T[] }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} disabled={disabled.includes(v)} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={value} aria-label={label} className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)} />;
}

function SettingsDialog({ inBoard, onClose }: { inBoard: boolean; onClose: () => void }) {
  const s = useSettings();
  const [tab, setTab] = useState<"general" | "canvas" | "about">("general");
  const set = <K extends keyof S>(k: K) => (v: S[K]) => s.set(k, v);
  return (
    <Dialog title="Settings" icon={<Settings size={18} />} onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === "general" ? "on" : ""} onClick={() => setTab("general")}>Preferences</button>
        {inBoard && <button className={tab === "canvas" ? "on" : ""} onClick={() => setTab("canvas")}>This canvas</button>}
        <button className={tab === "about" ? "on" : ""} onClick={() => setTab("about")}>Server & agents</button>
      </div>
      {tab === "canvas" && inBoard ? (
        <CanvasSettingsTab />
      ) : tab === "general" ? (
        <div className="settings">
          <h3>Appearance</h3>
          <Row label="Theme">
            <Segmented value={s.theme} options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]} onChange={set("theme")} />
          </Row>
          <Row label="Dot grid" hint="Blocks snap to it either way.">
            <Toggle label="Dot grid" value={s.showGrid} onChange={set("showGrid")} />
          </Row>
          <Row label="Minimap">
            <Toggle label="Minimap" value={s.minimap} onChange={set("minimap")} />
          </Row>
          <h3>Canvas</h3>
          <Row label="Scrolling" hint="Auto: two-finger scroll pans and pinch zooms on a trackpad; a mouse wheel zooms. Ctrl/⌘ + scroll always zooms.">
            <Segmented value={s.scrollMode} options={[["auto", "Auto"], ["zoom", "Zoom"], ["pan", "Pan"]]} onChange={set("scrollMode")} />
          </Row>
          <Row label="HTML live previews" hint="Live iframes are costly; “Auto” runs them only when zoomed in and on screen.">
            <Segmented value={s.htmlPreviews} options={[["auto", "Auto"], ["always", "Always"], ["never", "Never"]]} onChange={set("htmlPreviews")} />
          </Row>
          <Row label="Confirm before deleting" hint="Deleting can always be undone from the toast.">
            <Toggle label="Confirm before deleting" value={s.confirmDelete} onChange={set("confirmDelete")} />
          </Row>
          <h3>Editor</h3>
          <Row label="New blocks open in">
            <Segmented value={s.newBlockMode} options={[["raw", "Raw"], ["rendered", "Rendered"]]} onChange={set("newBlockMode")} />
          </Row>
          <Row label="Editor font size">
            <Segmented
              value={String(s.editorFontSize) as "12" | "13" | "14" | "15"}
              options={[["12", "12"], ["13", "13"], ["14", "14"], ["15", "15"]]}
              onChange={(v) => s.set("editorFontSize", Number(v))}
            />
          </Row>
          <div className="settings-foot">
            <span className="muted small">Preferences are saved in this browser.</span>
            <button className="btn small ghost" onClick={s.reset}>Reset to defaults</button>
          </div>
        </div>
      ) : (
        <About />
      )}
    </Dialog>
  );
}

/** Settings stored with the canvas (its think.json): the same in every browser. */
function CanvasSettingsTab() {
  const settings = useBoard((s) => s.project?.settings);
  const locked = useBoard((s) => s.lock.locked);
  if (!settings) return null;
  const label = (v: number) => (v === 0 ? "Only ⌘S" : v < 60 ? `${v} s` : `${v / 60} min`);
  const choices: [string, string][] = AUTOSAVE_CHOICES.map((v) => [String(v), label(v).replace("Only ⌘S", modLabel === "⌘" ? "Only ⌘S" : "Only Ctrl+S")]);
  if (!(AUTOSAVE_CHOICES as readonly number[]).includes(settings.autosaveSeconds)) choices.unshift([String(settings.autosaveSeconds), `${settings.autosaveSeconds} s`]);
  return (
    <div className="settings">
      <h3>Saving</h3>
      <Row
        label="Add to History every"
        hint={`Your edits are always saved as you type. This is how often they also become a point in History you can go back to — besides before every agent turn, on ${modLabel === "⌘" ? "⌘S" : "Ctrl+S"}, and when you leave.`}
      >
        <Segmented
          value={String(settings.autosaveSeconds)}
          options={choices}
          onChange={(v) => {
            if (locked) return;
            void act({ type: "canvas.settings", settings: { autosaveSeconds: Number(v) } });
          }}
        />
      </Row>
      <div className="settings-foot">
        <span className="muted small">Stored with the canvas (think.json), so it applies in every browser{locked ? " — changes wait until the canvas is free" : ""}.</span>
      </div>
    </div>
  );
}

function PlanUsage({ id, label }: { id: string; label: string }) {
  const [state, setState] = useState<{ windows?: { label: string; percent: number; resets: string | null }[]; error?: string; loading: boolean }>({ loading: false });
  const load = () => {
    setState({ loading: true });
    getJSON<{ windows: { label: string; percent: number; resets: string | null }[] }>(`/api/providers/${id}/usage`).then(
      (r) => setState({ windows: r.windows, loading: false }),
      (e: Error) => setState({ error: e.message, loading: false }),
    );
  };
  return (
    <div className="usage">
      <div className="usage-head">
        <span>{label} plan usage</span>
        <button className="btn small" onClick={load} disabled={state.loading}>
          {state.loading ? <span className="spinner tiny" /> : null} {state.windows ? "Refresh" : "Check usage"}
        </button>
      </div>
      {state.error && <div className="setting-hint danger-text">{state.error}</div>}
      {state.windows?.map((w) => (
        <div key={w.label} className="usage-row">
          <div className="usage-label">
            <span>{w.label}</span>
            <span className="muted">{w.percent}%{w.resets ? ` · resets ${w.resets}` : ""}</span>
          </div>
          <div className="usage-bar"><i style={{ width: `${Math.min(100, w.percent)}%` }} className={w.percent >= 90 ? "hot" : w.percent >= 70 ? "warm" : ""} /></div>
        </div>
      ))}
      {!state.windows && !state.error && <div className="setting-hint">Shared by everything using this subscription. Checking makes no model call.</div>}
    </div>
  );
}

function About() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const load = () => getJSON<ServerInfo>("/api/info").then(setInfo, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const switchAuth = (id: string, auth: "login" | "api-key") => {
    setSwitching(id);
    setProviderAuth(id, auth)
      .then(load, (e: Error) => toast.error(e.message))
      .finally(() => setSwitching(null));
  };
  if (error) return <p className="danger-text">{error}</p>;
  if (!info) return <div className="center-pad"><span className="spinner" /></div>;
  const c = info.config;
  return (
    <div className="settings about">
      <h3>Agent providers</h3>
      {info.providers.map((p) => {
        const keyMode = p.auth === "api-key";
        return (
          <div key={p.id} className="provider-row">
            <div>
              <div className="provider-name">{p.label} <span className="muted mono">{p.id}</span></div>
              <div className="setting-hint">
                {keyMode ? <>Uses <code>{p.apiKeyEnv}</code> from the server's environment</> : "Logs in inside its own isolated home on the server"}
                {p.permissionMode ? ` · permission mode “${p.permissionMode}”` : ""}
              </div>
              {p.apiKeyEnv && (
                <div className="provider-auth">
                  <Segmented
                    value={keyMode ? "api-key" : "login"}
                    options={[["login", "Its own sign-in"], ["api-key", "API key"]]}
                    disabled={switching === p.id ? ["login", "api-key"] : p.apiKeyOnServer || keyMode ? [] : ["api-key"]}
                    onChange={(v) => v !== (keyMode ? "api-key" : "login") && switchAuth(p.id, v)}
                  />
                  {!p.apiKeyOnServer && (
                    <span className="setting-hint">
                      To use a key, add <code>{p.apiKeyEnv}</code> to think's environment (its <code>.env</code> file) and restart think.
                    </span>
                  )}
                </div>
              )}
            </div>
            {keyMode ? (
              p.apiKeyOnServer ? (
                <span className="pill ok"><KeyRound size={12} /> API key</span>
              ) : (
                <span className="pill warn"><CircleSlash size={12} /> No key on the server</span>
              )
            ) : p.hasCredentials === null ? (
              <span className="pill">—</span>
            ) : p.hasCredentials ? (
              <span className="pill ok"><CheckCircle2 size={12} /> Logged in</span>
            ) : (
              <span className="pill warn"><CircleSlash size={12} /> Not logged in</span>
            )}
          </div>
        );
      })}
      {info.providers.filter((p) => p.reportsUsage && p.hasCredentials && p.auth === "login").map((p) => <PlanUsage key={p.id} id={p.id} label={p.label} />)}
      <h3>Server</h3>
      <dl className="kv">
        <dt>Version</dt><dd>{info.version}</dd>
        <dt>Data root</dt><dd className="mono">{info.root}</dd>
        <dt>Open canvases</dt><dd>{info.openProjects.length ? info.openProjects.join(", ") : "none"}</dd>
        <dt>Grid</dt><dd>{c.gridSize}px</dd>
        <dt>Validation retries</dt><dd>{c.validationMaxAttempts}</dd>
        <dt>Stop idle agents after</dt><dd>{c.agentIdleShutdownSeconds}s</dd>
        <dt>HTML live-preview zoom</dt><dd>{Math.round(c.htmlLiveZoom * 100)}%</dd>
        <dt>Access JWT check</dt><dd>{c.cfAccess ? "on" : "off"}</dd>
        <dt>Agents run</dt><dd>{c.agentPlacement === "runner" ? "in their own container (internet only)" : "alongside the server"}</dd>
        <dt>App password</dt>
        <dd>
          {c.passwordLogin ? (
            <>
              on ·{" "}
              <button className="link-btn" onClick={() => void fetch("/api/logout", { method: "POST" }).then(() => location.assign("/login"))}>
                Sign out
              </button>
            </>
          ) : (
            "off"
          )}
        </dd>
      </dl>
      <h3>Block name pool</h3>
      <p className="name-pool">{info.namePool.map((n) => displayName(n)).join(" · ")}</p>
      <p className="muted small">Server settings are the app's own, with overrides (the sign-in switch above among them) in <code>config/</code> in the data folder; prompt templates likewise in <code>prompts/</code>. Both are re-read on change, no restart needed.</p>
    </div>
  );
}
