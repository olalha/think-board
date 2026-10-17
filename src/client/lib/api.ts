// HTTP helpers for the handful of non-WebSocket endpoints.

export class ApiError extends Error {}

async function handle<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg);
  }
  return body as T;
}

export async function getJSON<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { headers: { Accept: "application/json" } }));
}

export async function sendJSON<T>(method: "POST" | "PATCH", url: string, data: unknown): Promise<T> {
  return handle<T>(await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }));
}

/** Switch a provider between its own sign-in and the server's API key (its agents restart). */
export function setProviderAuth(id: string, auth: "login" | "api-key"): Promise<{ ok: true }> {
  return sendJSON("POST", `/api/providers/${encodeURIComponent(id)}/auth`, { auth });
}

/** Upload an image block. XHR rather than fetch, for upload progress (0–1). */
/** POST a file with upload progress (fetch can't report it). Resolves with the JSON body. */
function postFile<T>(url: string, file: Blob, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError("The upload failed — check the connection."));
    xhr.onload = () => {
      let body: (T & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* empty or non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new ApiError(body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.send(file);
  });
}

export async function uploadImage(slug: string, file: Blob, opts: { x?: number; y?: number; replace?: string; onProgress?: (p: number) => void }): Promise<{ name: string }> {
  const q = new URLSearchParams();
  if (opts.x !== undefined) q.set("x", String(Math.round(opts.x)));
  if (opts.y !== undefined) q.set("y", String(Math.round(opts.y)));
  if (opts.replace) q.set("replace", opts.replace);
  const body = await postFile<{ name?: string }>(`/api/projects/${slug}/images?${q}`, file, opts.onProgress);
  if (!body.name) throw new ApiError("Upload failed");
  return { name: body.name };
}

/** A photo to become a drawing's page: kept next to the drawing; the editor then saves the drawing on it. */
export function uploadDrawingBase(slug: string, name: string, file: Blob, onProgress?: (p: number) => void): Promise<{ file: string; width: number; height: number }> {
  return postFile(`/api/projects/${slug}/drawings/${name}/base`, file, onProgress);
}

/** Resolves once the browser has the image (so it shows at once when used), or failed to get it. */
export function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
    void img.decode?.().then(resolve, resolve);
  });
}

export function fileUrl(slug: string, file: string, version?: string): string {
  return `/api/projects/${slug}/files/${file}${version ? `?v=${version.slice(0, 12)}` : ""}`;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  provider: string;
  blocks: number;
  updatedAt: string | null;
  open: boolean;
  working: boolean;
  description: string;
  /** Why this version of think cannot open it (e.g. made by a newer one). */
  problem?: string;
}

export interface ServerInfo {
  version: string;
  root: string;
  config: {
    gridSize: number;
    htmlLiveZoom: number;
    validationMaxAttempts: number;
    defaultAutosaveSeconds: number;
    agentIdleShutdownSeconds: number;
    defaultProvider: string;
    cfAccess: boolean;
    passwordLogin?: boolean;
    agentPlacement?: "runner" | "local";
  };
  namePool: string[];
  providers: {
    id: string;
    label: string;
    auth: string;
    permissionMode: string | null;
    hasCredentials: boolean | null;
    reportsUsage?: boolean;
    /** The API key's variable name (never its value), and whether the server has it. */
    apiKeyEnv?: string | null;
    apiKeyOnServer?: boolean;
  }[];
  openProjects: string[];
}
