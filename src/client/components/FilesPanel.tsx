// The side panel's Files tab: the canvas's files/ folder — reference material
// that is not a block (spreadsheets, archives, documents, data). Upload (button
// or drop), preview text, CSV and images, download, rename or move, delete.
// The list itself comes from the server (`files.changed`), so every tab and the
// agent's own additions show up live.
import { useEffect, useRef, useState } from "react";
import { Download, File as FileIcon, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Pencil, Search, Trash2, Upload } from "lucide-react";
import { MAX_REFERENCE_FILE_BYTES, type ReferenceFile } from "../../shared/protocol";
import { MarkdownView } from "../blocks/renderers";
import { deleteReferenceFile, moveReferenceFile, referenceFileUrl, uploadReferenceFile } from "../lib/api";
import { currentSlug } from "../lib/project";
import { useBoard } from "../lib/store";
import { useSettings } from "../lib/settings";
import { toast } from "../lib/toasts";
import { useCanvasUi } from "../canvas/ui-state";
import { guessDelimiter, parseDelimited } from "../lib/csv";
import { Dialog } from "./Dialogs";

/** Lines of a text file shown in a preview. */
const PREVIEW_LINES = 200;
/** …and at most this much of it is read. */
const PREVIEW_BYTES = 512 * 1024;

const ext = (p: string) => (/\.([^./]+)$/.exec(p)?.[1] ?? "").toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TABLE = new Set(["csv", "tsv"]);
const MARKDOWN = new Set(["md", "markdown"]);
const TEXT = new Set(["txt", "json", "log", ...MARKDOWN, ...TABLE]);

type PreviewKind = "image" | "table" | "markdown" | "text" | null;
function previewKind(p: string): PreviewKind {
  const e = ext(p);
  if (IMAGE.has(e)) return "image";
  if (TABLE.has(e)) return "table";
  if (MARKDOWN.has(e)) return "markdown";
  if (TEXT.has(e)) return "text";
  return null;
}

function iconFor(p: string): typeof FileIcon {
  const e = ext(p);
  if (IMAGE.has(e) || ["svg", "heic", "tif", "tiff", "bmp"].includes(e)) return FileImage;
  if (TABLE.has(e) || ["xlsx", "xls", "ods", "numbers"].includes(e)) return FileSpreadsheet;
  if (["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"].includes(e)) return FileArchive;
  if (["json", "xml", "yaml", "yml", "html", "js", "ts", "py", "sql", "sh"].includes(e)) return FileCode;
  if (MARKDOWN.has(e) || ["txt", "pdf", "doc", "docx", "odt", "rtf", "pages", "log"].includes(e)) return FileText;
  return FileIcon;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Can the user change files/ right now? Says why not, once. */
function blocked(): boolean {
  const s = useBoard.getState();
  if (s.timeTravel) {
    toast.info("You're looking at the canvas's history — press Esc to return to the live canvas.");
    return true;
  }
  if (s.lock.locked) {
    toast.info(s.lock.reason === "guest" ? `${s.lock.by} is working on this canvas — try again when they finish.` : "The agent is working — try again when it finishes.");
    return true;
  }
  return false;
}

/** Uploads in progress (name → 0–1), shared by the tab and the rail's drop target. */
let setUploadsGlobal: ((fn: (u: Record<string, number>) => Record<string, number>) => void) | null = null;

/** Upload files into files/ (one at a time), from the button or a drop. */
export async function uploadFiles(files: File[]): Promise<void> {
  const slug = currentSlug();
  if (!slug || !files.length || blocked()) return;
  const setUploads = (fn: (u: Record<string, number>) => Record<string, number>) => setUploadsGlobal?.(fn);
  let done = 0;
  for (const f of files) {
    if (f.size > MAX_REFERENCE_FILE_BYTES) {
      toast.error(`${f.name} is ${formatSize(f.size)} — files can be up to ${formatSize(MAX_REFERENCE_FILE_BYTES)}.`);
      continue;
    }
    setUploads((u) => ({ ...u, [f.name]: 0 }));
    try {
      const r = await uploadReferenceFile(slug, f.name, f, (p) => setUploads((u) => ({ ...u, [f.name]: p })));
      done++;
      if (r.path !== f.name) toast.info(`${f.name} was already there — the new one is ${r.path}.`);
    } catch (err) {
      toast.error(`${f.name}: ${(err as Error).message}`);
    } finally {
      setUploads(({ [f.name]: _gone, ...rest }) => rest);
    }
  }
  if (done) toast.success(done === 1 ? "File added" : `${done} files added`);
}

/** A drag carrying files from the computer (not a block, not text). */
export const dragHasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

export function FilesPanel() {
  const files = useBoard((s) => s.refFiles);
  const locked = useBoard((s) => s.lock.locked);
  const slug = useBoard((s) => s.slug);
  const [q, setQ] = useState("");
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReferenceFile | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUploadsGlobal = setUploads;
    return () => {
      if (setUploadsGlobal === setUploads) setUploadsGlobal = null;
    };
  }, []);
  useEffect(() => {
    if (locked) setEditing(null);
  }, [locked]);
  // The file being previewed went away (deleted, renamed elsewhere): close it.
  useEffect(() => {
    if (preview && !files.some((f) => f.path === preview.path)) setPreview(null);
  }, [files, preview]);

  const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase()));
  const total = files.reduce((n, f) => n + f.size, 0);

  const remove = (f: ReferenceFile) => {
    if (blocked() || !slug) return;
    const run = async () => {
      try {
        await deleteReferenceFile(slug, f.path);
        toast.success(`Deleted ${baseName(f.path)}`);
      } catch (err) {
        toast.error((err as Error).message);
      }
    };
    if (useSettings.getState().confirmDelete) {
      useCanvasUi.getState().askConfirm({
        title: `Delete ${baseName(f.path)}?`,
        body: "The file is removed from the canvas's files/ folder. History keeps it once it has been saved there.",
        action: "Delete",
        danger: true,
        run: () => void run(),
      });
    } else void run();
  };

  return (
    <div
      className={`files ${over ? "drop-over" : ""}`}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = locked ? "none" : "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void uploadFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="views-actions">
        <button className="btn small primary" disabled={locked} onClick={() => input.current?.click()} data-tip={`Add files (up to ${formatSize(MAX_REFERENCE_FILE_BYTES)} each) — or drop them here`}>
          <Upload size={14} /> Upload
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = "";
            void uploadFiles(list);
          }}
        />
        {files.length > 0 && (
          <span className="muted small files-total">
            {files.length} {files.length === 1 ? "file" : "files"} · {formatSize(total)}
          </span>
        )}
      </div>
      {files.length > 8 && (
        <div className="side-search">
          <Search size={14} />
          <input value={q} placeholder={`Filter ${files.length} files`} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {Object.entries(uploads).map(([name, p]) => (
        <div key={`up-${name}`} className="file-row uploading">
          <Upload size={14} />
          <span className="file-main">
            <span className="file-name">{name}</span>
            <span className="file-progress">
              <i style={{ width: `${Math.round(p * 100)}%` }} />
            </span>
          </span>
        </div>
      ))}
      <ul className="file-list">
        {shown.map((f) => {
          const Icon = iconFor(f.path);
          const folder = folderOf(f.path);
          return (
            <li key={f.path} className="file-row">
              {editing === f.path ? (
                <FileName file={f} onDone={() => setEditing(null)} />
              ) : (
                <button className="file-main" onClick={() => (previewKind(f.path) ? setPreview(f) : (window.location.href = referenceFileUrl(slug!, f.path, { download: true })))} data-tip={previewKind(f.path) ? "Preview" : "Download"}>
                  <Icon size={15} className="file-icon" />
                  <span className="file-text">
                    <span className="file-name">{baseName(f.path)}</span>
                    <span className="file-meta">
                      {folder && <span className="file-folder">{folder}/ · </span>}
                      {formatSize(f.size)} · {formatDate(f.mtime)}
                    </span>
                  </span>
                </button>
              )}
              <span className="file-tools">
                <a className="icon-btn tiny" href={slug ? referenceFileUrl(slug, f.path, { download: true }) : undefined} download={baseName(f.path)} aria-label={`Download ${baseName(f.path)}`} data-tip="Download">
                  <Download size={12} />
                </a>
                <button className="icon-btn tiny" aria-label={`Rename ${baseName(f.path)}`} data-tip="Rename or move" disabled={locked} onClick={() => setEditing(f.path)}>
                  <Pencil size={12} />
                </button>
                <button className="icon-btn tiny" aria-label={`Delete ${baseName(f.path)}`} data-tip="Delete" disabled={locked} onClick={() => remove(f)}>
                  <Trash2 size={12} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {files.length === 0 && !Object.keys(uploads).length && (
        <p className="side-empty">
          Reference material that isn't a block — spreadsheets, documents, archives, data. Upload files or drop them here; they're kept in the canvas's <code>files/</code> folder with its history, and the agent can read them (and leave exports here).
        </p>
      )}
      {q && files.length > 0 && shown.length === 0 && <p className="side-empty">No file matches “{q}”.</p>}
      {preview && slug && <FilePreview slug={slug} file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Rename in place; a path with folders ("data/2024.csv") moves it. */
function FileName({ file, onDone }: { file: ReferenceFile; onDone: () => void }) {
  const [value, setValue] = useState(file.path);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, as file managers do.
    const start = file.path.lastIndexOf("/") + 1;
    const dot = file.path.lastIndexOf(".");
    el.setSelectionRange(start, dot > start ? dot : file.path.length);
  }, [file.path]);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const to = value.trim();
    const slug = currentSlug();
    if (save && slug && to && to !== file.path && !blocked()) {
      try {
        await moveReferenceFile(slug, file.path, to);
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    onDone();
  };
  return (
    <input
      ref={ref}
      className="view-input"
      value={value}
      maxLength={400}
      aria-label="File name"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") void finish(true);
        if (e.key === "Escape") void finish(false);
      }}
      onBlur={() => void finish(true)}
    />
  );
}

// ---------------------------------------------------------------- preview

/** The start of a text file: up to PREVIEW_LINES lines, without reading the rest. */
async function readHead(url: string): Promise<{ lines: string[]; more: boolean }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Couldn't read the file (${res.status}).`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let more = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    text += decoder.decode(value, { stream: true });
    if (bytes >= PREVIEW_BYTES || text.split("\n").length > PREVIEW_LINES + 1) {
      more = true;
      void reader.cancel();
      break;
    }
  }
  if (!more) text += decoder.decode();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > PREVIEW_LINES) {
    more = true;
    lines.length = PREVIEW_LINES;
  } else if (!more && lines[lines.length - 1] === "") lines.pop();
  return { lines, more };
}

function FilePreview({ slug, file, onClose }: { slug: string; file: ReferenceFile; onClose: () => void }) {
  const kind = previewKind(file.path);
  const url = referenceFileUrl(slug, file.path, { version: file.mtime });
  const [data, setData] = useState<{ lines: string[]; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (kind === "image" || !kind) return;
    let live = true;
    readHead(url).then(
      (d) => live && setData(d),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [url, kind]);

  let body: React.ReactNode;
  if (kind === "image") body = <img className="file-preview-img" src={url} alt={baseName(file.path)} />;
  else if (error) body = <p className="muted">{error}</p>;
  else if (!data) body = <div className="center-pad"><span className="spinner" /></div>;
  else if (kind === "markdown") body = <MarkdownView source={data.lines.join("\n")} />;
  else if (kind === "table") {
    const rows = parseDelimited(data.lines.join("\n"), guessDelimiter(file.path, data.lines[0] ?? ""));
    const cols = Math.min(50, Math.max(0, ...rows.map((r) => r.length)));
    const [head, ...rest] = rows;
    body = (
      <div className="file-table-wrap">
        <table className="file-table">
          {head && (
            <thead>
              <tr>{Array.from({ length: cols }, (_, i) => <th key={i}>{head[i] ?? ""}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {rest.map((r, i) => (
              <tr key={i}>{Array.from({ length: cols }, (_, j) => <td key={j}>{r[j] ?? ""}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else body = <pre className="file-preview-text">{data.lines.join("\n")}</pre>;

  return (
    <Dialog
      title={baseName(file.path)}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small grow">
            {formatSize(file.size)}
            {data?.more ? ` · the first ${PREVIEW_LINES} lines` : ""}
          </span>
          <a className="btn" href={referenceFileUrl(slug, file.path, { download: true })} download={baseName(file.path)}>
            <Download size={14} /> Download
          </a>
          <button className="btn primary" onClick={onClose}>Close</button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
