import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Blocks, HelpCircle, Plus, Search, Settings } from "lucide-react";
import { getJSON, sendJSON, type ProjectSummary, type ServerInfo } from "../lib/api";
import { navigate } from "../lib/router";
import { toast } from "../lib/toasts";
import { useCanvasUi } from "../canvas/ui-state";
import { Dialog, DialogHost } from "../components/Dialogs";
import { Logo } from "../components/Logo";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const setDialog = useCanvasUi((s) => s.setDialog);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    getJSON<ProjectSummary[]>("/api/projects").then(setProjects, (e: Error) => toast.error(e.message));
  }, []);

  useEffect(() => {
    document.title = "think";
    refresh();
    getJSON<ServerInfo>("/api/info").then(setInfo, () => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || document.querySelector(".overlay")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q));
  }, [projects, query]);

  const providerLabel = (id: string) => info?.providers.find((p) => p.id === id)?.label ?? id;

  return (
    <div className="list-page">
      <header className="list-head">
        <div className="list-brand">
          <Logo size={28} />
          <span className="list-title">think</span>
        </div>
        <div className="list-actions">
          <button className="icon-btn" aria-label="Help" data-tip="Help (?)" onClick={() => setDialog("help")}>
            <HelpCircle size={18} />
          </button>
          <button className="icon-btn" aria-label="Settings" data-tip="Settings" onClick={() => setDialog("settings")}>
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="list-hero">
        <h1>Your canvases</h1>
        <p>Infinite boards of Markdown, diagrams, HTML and images — each with its own agent that edits the files alongside you.</p>
        <div className="list-controls">
          <label className="search">
            <Search size={15} />
            <input ref={searchRef} placeholder="Search canvases" value={query} onChange={(e) => setQuery(e.target.value)} />
            <kbd>/</kbd>
          </label>
          <button className="btn primary large" onClick={() => setCreating(true)}>
            <Plus size={16} /> New canvas <kbd className="on-accent">N</kbd>
          </button>
        </div>
      </section>

      <section className="list-grid">
        {projects === null &&
          Array.from({ length: 3 }, (_, i) => <div key={i} className="project-card skeleton" />)}
        {projects !== null && projects.length === 0 && (
          <div className="list-empty">
            <Blocks size={28} />
            <h2>No canvases yet</h2>
            <p>Create one to start thinking out loud with an agent.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Create your first canvas
            </button>
          </div>
        )}
        {shown.map((p, i) => (
          <button
            key={p.slug}
            className={`project-card ${p.problem ? "has-problem" : ""}`}
            style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
            onClick={() => (p.problem ? toast.error(p.problem) : navigate(`/p/${p.slug}`))}
          >
            <div className="project-card-top">
              <span className="project-card-name">{p.name}</span>
              {p.problem ? (
                <span className="pill warn" data-tip={p.problem}>Needs a newer think</span>
              ) : p.working ? (
                <span className="pill accent"><span className="dot pulse" />Agent working</span>
              ) : p.open ? (
                <span className="pill ok"><span className="dot" />Open</span>
              ) : null}
            </div>
            {p.description ? <div className="project-card-desc">{p.description}</div> : <div className="project-card-slug mono">{p.slug}</div>}
            <div className="project-card-meta">
              <span>{p.blocks} {p.blocks === 1 ? "block" : "blocks"}</span>
              <span>·</span>
              <span>{relative(p.updatedAt)}</span>
              <span className="grow" />
              <span className="provider-chip">{providerLabel(p.provider)}</span>
            </div>
            <ArrowRight size={16} className="project-card-go" />
          </button>
        ))}
        {projects !== null && projects.length > 0 && shown.length === 0 && <div className="muted">No canvas matches “{query}”.</div>}
      </section>

      {creating && <CreateDialog info={info} onClose={() => setCreating(false)} />}
      <DialogHost inBoard={false} />
    </div>
  );
}

function CreateDialog({ info, onClose }: { info: ServerInfo | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState(info?.config.defaultProvider ?? "claude-code");
  const [busy, setBusy] = useState(false);
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  const create = async () => {
    if (!slug || busy) return;
    setBusy(true);
    try {
      const r = await sendJSON<{ slug: string }>("POST", "/api/projects", { name: name.trim(), provider, description: description.trim() || undefined });
      navigate(`/p/${r.slug}`);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New canvas"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!slug || busy} onClick={() => void create()}>
            {busy ? <span className="spinner tiny" /> : null} Create canvas
          </button>
        </>
      }
    >
      <form
        className="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="field">
          <label htmlFor="cname">Name</label>
          <input id="cname" className="input" autoFocus value={name} maxLength={100} placeholder="e.g. Launch plan" onChange={(e) => setName(e.target.value)} />
          <span className="hint">
            Folder: <span className="mono">data/{slug || "…"}</span> — its own git repository.
          </span>
        </div>
        <div className="field">
          <label htmlFor="cdesc">What is it about? <span className="muted">(optional)</span></label>
          <textarea
            id="cdesc"
            className="input"
            rows={2}
            value={description}
            maxLength={2000}
            placeholder="e.g. Planning the spring launch: channels, timing, open questions"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void create();
              }
            }}
          />
          <span className="hint">Becomes the canvas's README — the agent reads it first and keeps it up to date.</span>
        </div>
        <div className="field">
          <label>Agent</label>
          <div className="provider-options">
            {(info?.providers ?? [{ id: "claude-code", label: "Claude Code", auth: "login", permissionMode: null, hasCredentials: null }]).map((p) => (
              <label key={p.id} className={`provider-option ${provider === p.id ? "on" : ""}`}>
                <input type="radio" name="provider" value={p.id} checked={provider === p.id} onChange={() => setProvider(p.id)} />
                <div>
                  <div className="provider-name">{p.label}</div>
                  <div className="setting-hint">
                    {p.hasCredentials === false ? "You'll be asked to log in when the canvas opens." : p.hasCredentials ? "Logged in and ready." : "An ACP agent."}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
