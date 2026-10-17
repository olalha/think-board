// Prompt templates.
//
// Every piece of text the app adds to an agent's context comes from a Markdown
// file in prompts/ — never from a string in code. Templates are read at use
// time, so an edit applies to the very next prompt. Placeholders are
// `{{name}}`; an unknown placeholder is left as-is and reported, so a typo is
// visible in the output rather than silently becoming an empty string.

import fs from "node:fs/promises";
import path from "node:path";

export type TemplateName =
  | "project-claude.md"
  | "turn-suffix.md"
  | "user-changes.md"
  | "validation-errors.md"
  | (string & {});

export interface RenderedTemplate {
  text: string;
  missing: string[];
}

export function renderTemplate(source: string, vars: Record<string, string | number>): RenderedTemplate {
  const missing: string[] = [];
  const text = source.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) => {
    if (Object.hasOwn(vars, key)) return String(vars[key]);
    missing.push(key);
    return whole;
  });
  return { text, missing };
}

export class Templates {
  constructor(
    private readonly promptsDir: string,
    private readonly onMissing: (template: string, keys: string[]) => void = () => {},
    /** Overrides, file by file (ROOT/prompts). */
    private readonly userPromptsDir?: string,
  ) {}

  async render(name: TemplateName, vars: Record<string, string | number> = {}): Promise<string> {
    let source: string | null = null;
    if (this.userPromptsDir) source = await fs.readFile(path.join(this.userPromptsDir, name), "utf8").catch(() => null);
    source ??= await fs.readFile(path.join(this.promptsDir, name), "utf8");
    const { text, missing } = renderTemplate(source, vars);
    if (missing.length) this.onMissing(name, missing);
    return text.trim();
  }
}
