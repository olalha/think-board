// /render/<project>/<block> — one block, rendered alone with the same pure
// components the board uses, and nothing else on the page. Reserved for the
// annotation feature (a headless browser screenshots this route); also handy
// for opening a block full-screen.
import { useEffect, useState } from "react";
import type { BlockType } from "../../shared/blocks";
import { displayName } from "../../shared/blocks";
import { fileUrl, getJSON } from "../lib/api";
import { effectiveTheme, useSettings } from "../lib/settings";
import { HtmlView, ImageView, MarkdownView, MermaidView } from "../blocks/renderers";

interface BlockData {
  name: string;
  file: string;
  type: BlockType;
  content?: string;
}

export function RenderPage({ slug, block }: { slug: string; block: string }) {
  const [data, setData] = useState<BlockData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const themeSetting = useSettings((s) => s.theme);
  const q = new URLSearchParams(location.search).get("theme");
  const theme = q === "dark" || q === "light" ? q : effectiveTheme(themeSetting);

  useEffect(() => {
    document.title = `${displayName(block)} · think`;
    getJSON<BlockData>(`/api/projects/${slug}/blocks/${block}`).then(setData, (e: Error) => setError(e.message));
  }, [slug, block]);

  useEffect(() => {
    if (q === "dark" || q === "light") document.documentElement.dataset.theme = q;
  }, [q]);

  if (error) return <div className="render-page render-error">{error}</div>;
  if (!data) return <div className="render-page" />;
  return (
    <div className={`render-page type-${data.type}`} data-render-ready="true">
      {data.type === "markdown" && (
        <div className="render-md">
          <MarkdownView source={data.content ?? ""} resolveFile={(f) => fileUrl(slug, f)} />
        </div>
      )}
      {data.type === "mermaid" && <MermaidView source={data.content ?? ""} theme={theme} />}
      {data.type === "html" && <HtmlView source={data.content ?? ""} title={displayName(block)} />}
      {data.type === "image" && <ImageView src={fileUrl(slug, data.file)} alt={displayName(block)} />}
    </div>
  );
}
