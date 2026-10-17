// Block identity and typing rules, shared by server and client.
//
// A block is one top-level file in a project folder. Its name is the filename
// stem and must be unique across extensions; its type follows from the
// extension. Anything else in the folder is ignored by the canvas.

export type BlockType = "markdown" | "mermaid" | "html" | "image";

export const EXTENSION_TYPES: Record<string, BlockType> = {
  md: "markdown",
  mmd: "mermaid",
  html: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
};

/** The extension a newly created block of each text type gets. */
export const TYPE_EXTENSION: Record<Exclude<BlockType, "image">, string> = {
  markdown: "md",
  mermaid: "mmd",
  html: "html",
};

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;

/**
 * Precedence when two files share a stem (e.g. `harry.md` and `harry.png`).
 * Names must be unique; the lower index keeps the name and the other file is
 * reported as a conflict rather than silently shown.
 */
export const EXTENSION_PRECEDENCE = ["md", "mmd", "html", "png", "jpg", "jpeg", "webp", "gif"];

/** Lowercase letters, digits and inner hyphens: `harry`, `harry-2`. */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BLOCK_FILE_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z]+)$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Parse a top-level filename into a block identity, or null if it is not a block. */
export function parseBlockFile(file: string): { name: string; ext: string; type: BlockType } | null {
  const m = BLOCK_FILE_RE.exec(file);
  if (!m) return null;
  const type = EXTENSION_TYPES[m[2]];
  if (!type) return null;
  return { name: m[1], ext: m[2], type };
}

export function isTextType(type: BlockType): type is Exclude<BlockType, "image"> {
  return type !== "image";
}

/**
 * Words that read as acronyms (names are lowercase on disk, so `cli-notes`
 * would otherwise show as "Cli notes"). Only unambiguous ones: a word that is
 * also an ordinary English word stays out.
 */
const ACRONYMS = new Set(
  "acp ai api cd ci cli cpu crm css csv db dns faq gpu gui html http https id ide jwt kpi llm mcp mvp okr pdf pr qa roi sdk seo sql ssh ssl svg tls ui url ux vm vpn xml yaml".split(" "),
);
const MIXED_CASE: Record<string, string> = { ios: "iOS", macos: "macOS", github: "GitHub", oauth: "OAuth", json: "JSON" };

/** `harry` → `Harry`, `tea-flowchart` → `Tea flowchart`, `harry-2` → `Harry 2`, `cli-notes` → `CLI notes`. */
export function displayName(name: string): string {
  const words = name.split("-").map((w) => MIXED_CASE[w] ?? (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const spaced = words.join(" ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Turn what someone typed as a block name into a valid one:
 * `Tea Flowchart!` → `tea-flowchart`. Returns "" when nothing usable is left.
 */
export function toBlockName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function extensionForMime(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

/** Default and minimum block sizes, in canvas pixels (snapped to the grid on use). */
export const BLOCK_SIZES: Record<BlockType, { width: number; height: number; minWidth: number; minHeight: number }> = {
  markdown: { width: 360, height: 260, minWidth: 160, minHeight: 100 },
  mermaid: { width: 420, height: 300, minWidth: 180, minHeight: 120 },
  html: { width: 480, height: 360, minWidth: 200, minHeight: 140 },
  image: { width: 320, height: 240, minWidth: 80, minHeight: 80 },
};

/** Content a block starts with when the user creates it from the canvas. */
export function initialContent(type: Exclude<BlockType, "image">, name: string): string {
  const title = displayName(name);
  switch (type) {
    case "markdown":
      return `# ${title}\n\n`;
    case "mermaid":
      return "flowchart LR\n  A[Start] --> B[Next]\n";
    case "html":
      return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<style>\n  body { font-family: system-ui, sans-serif; margin: 16px; }\n</style>\n</head>\n<body>\n  <h1>${title}</h1>\n</body>\n</html>\n`;
  }
}
