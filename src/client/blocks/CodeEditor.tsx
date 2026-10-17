// CodeMirror 6 raw editor for a text block.
//
// - Autosave goes through queueEdit (debounced ~500ms).
// - Changes arriving from the server (the agent, another tab) replace the
//   document with a minimal diff, so the cursor and scroll position survive.
// - Read-only while the agent holds the lock.
// - Colours come from CSS variables, so it follows light/dark without rebuilding.

import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getSearchQuery, highlightSelectionMatches, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";
import { flowchartTags, ganttTags, journeyTags, mermaid, mermaidTags, mindmapTags, pieTags, requirementTags, sequenceTags } from "codemirror-lang-mermaid";
import type { BlockType } from "../../shared/blocks";
import { hasPendingEdit, onBlockContent, queueEdit } from "../lib/project";
import { recordEdit } from "../canvas/actions";
import { useBoard } from "../lib/store";

const Remote = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6, t.heading], color: "var(--syn-heading)", fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--syn-link)" },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.tagName], color: "var(--syn-tag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-attr)" },
  { tag: [t.string, t.attributeValue, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.monospace], color: "var(--syn-code)" },
  { tag: [t.processingInstruction, t.meta, t.documentMeta], color: "var(--syn-meta)" },
  { tag: [t.quote], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.list], color: "var(--syn-keyword)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--syn-variable)" },
  { tag: [t.function(t.variableName), t.className], color: "var(--syn-attr)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.angleBracket], color: "var(--syn-punct)" },
  // codemirror-lang-mermaid's own tags
  { tag: [mermaidTags.diagramName, flowchartTags.diagramName, sequenceTags.diagramName, pieTags.diagramName, ganttTags.diagramName, journeyTags.diagramName, mindmapTags.diagramName, requirementTags.diagramName], color: "var(--syn-keyword)", fontWeight: "650" },
  { tag: [flowchartTags.keyword, flowchartTags.orientation, sequenceTags.keyword1, sequenceTags.keyword2, ganttTags.keyword, journeyTags.keyword, requirementTags.keyword, pieTags.title, pieTags.showData], color: "var(--syn-keyword)" },
  { tag: [flowchartTags.nodeId, sequenceTags.nodeText, journeyTags.actor], color: "var(--syn-variable)" },
  { tag: [flowchartTags.nodeText, flowchartTags.nodeEdgeText, sequenceTags.messageText1, sequenceTags.messageText2, journeyTags.text, pieTags.titleText, mindmapTags.lineText1, mindmapTags.lineText3, mindmapTags.lineText5], color: "var(--syn-string)" },
  { tag: [mindmapTags.lineText2, mindmapTags.lineText4], color: "var(--syn-attr)" },
  { tag: [flowchartTags.nodeEdge, flowchartTags.link, sequenceTags.arrow, requirementTags.arrow], color: "var(--syn-tag)" },
  { tag: [flowchartTags.string, pieTags.string, ganttTags.string, requirementTags.quotedString], color: "var(--syn-string)" },
  { tag: [flowchartTags.number, pieTags.number, requirementTags.number, journeyTags.score], color: "var(--syn-number)" },
  { tag: [flowchartTags.lineComment, sequenceTags.lineComment, pieTags.lineComment, ganttTags.lineComment, journeyTags.lineComment, requirementTags.lineComment], color: "var(--syn-comment)", fontStyle: "italic" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size, 13px)", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-3)", border: "none", paddingLeft: "4px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "26px", padding: "0 6px 0 0", fontSize: "11px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
  // The search bar in the app's colours (the library's are light-only).
  ".cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px", padding: "6px 30px 6px 8px", fontFamily: "var(--font-sans)" },
  ".cm-search br": { flexBasis: "100%", height: 0 },
  ".cm-textfield": {
    margin: 0,
    padding: "3px 7px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    backgroundColor: "var(--panel)",
    color: "var(--text)",
    outline: "none",
  },
  ".cm-textfield:focus": { borderColor: "var(--accent)" },
  ".cm-button": {
    margin: 0,
    padding: "3px 8px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    backgroundImage: "none",
    backgroundColor: "var(--panel)",
    color: "var(--text-2)",
    textTransform: "none",
    cursor: "pointer",
  },
  ".cm-button:hover": { backgroundColor: "var(--hover)", color: "var(--text)" },
  ".cm-button:active": { backgroundImage: "none" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--text-2)", fontSize: "12px" },
  ".cm-search input[type=checkbox]": { margin: 0, accentColor: "var(--accent)" },
  ".cm-search [name=close]": { color: "var(--text-3)", fontSize: "16px", top: "4px", right: "6px" },
  ".cm-search-count": { minWidth: "64px", color: "var(--text-3)", fontSize: "12px", fontVariantNumeric: "tabular-nums" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)" },
});

function languageFor(type: BlockType): Extension {
  switch (type) {
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "mermaid":
      return mermaid();
    default:
      return [];
  }
}

/**
 * "3 of 12" in the search bar — the library's panel has no count, so this
 * adds one to it and keeps it current. Counting stops at 10 000.
 */
const searchCount = ViewPlugin.fromClass(
  class {
    el: HTMLElement | null = null;
    constructor(view: EditorView) {
      this.sync(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.length) || searchPanelOpen(u.state) !== searchPanelOpen(u.startState)) this.sync(u.view);
    }
    sync(view: EditorView) {
      if (!searchPanelOpen(view.state)) {
        this.el = null;
        return;
      }
      const panel = view.dom.querySelector(".cm-search");
      if (!panel) return;
      if (!this.el || !panel.contains(this.el)) {
        this.el = document.createElement("span");
        this.el.className = "cm-search-count";
        this.el.setAttribute("aria-live", "polite");
        const next = panel.querySelector("button[name=next]");
        panel.insertBefore(this.el, next ?? null);
      }
      const q = getSearchQuery(view.state);
      if (!q.search || !q.valid) {
        this.el.textContent = "";
        return;
      }
      const sel = view.state.selection.main;
      let total = 0;
      let current = 0;
      const cursor = q.getCursor(view.state) as Iterator<{ from: number; to: number }>;
      for (let r = cursor.next(); !r.done && total < 10000; r = cursor.next()) {
        total++;
        if (r.value.from === sel.from && r.value.to === sel.to) current = total;
      }
      this.el.textContent = total === 0 ? "No results" : current ? `${current} of ${total}${total >= 10000 ? "+" : ""}` : `${total}${total >= 10000 ? "+" : ""} found`;
    }
    destroy() {
      this.el?.remove();
    }
  },
);

/** Replace the document with the smallest change that turns it into `next`. */
function minimalReplace(view: EditorView, next: string): void {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let start = 0;
  const max = Math.min(cur.length, next.length);
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--;
    endNext--;
  }
  view.dispatch({
    changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
    annotations: [Remote.of(true)],
  });
}

export function CodeEditor({
  name,
  type,
  content,
  readOnly,
  autoFocus,
  onEscape,
  scrollable,
  wrap,
  onToggleWrap,
}: {
  name: string;
  type: BlockType;
  content: string;
  readOnly: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
  /** Take the wheel (scroll the source) — only while the block is selected. */
  scrollable: boolean;
  /** Wrap long lines. */
  wrap: boolean;
  onToggleWrap?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const visitStart = useRef<string | null>(null);
  const toggleWrapRef = useRef(onToggleWrap);
  toggleWrapRef.current = onToggleWrap;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(highlight),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          searchCount,
          wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
          keymap.of([
            {
              // Esc or ⌘/Ctrl+Enter: done editing — back to the preview, block still selected.
              key: "Escape",
              run: (v) => {
                v.contentDOM.blur();
                escapeRef.current?.();
                return true;
              },
            },
            {
              // Alt+Z (as in VS Code): wrap long lines on/off for this block.
              key: "Alt-z",
              preventDefault: true,
              run: () => {
                toggleWrapRef.current?.();
                return true;
              },
            },
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: (v) => {
                v.contentDOM.blur();
                escapeRef.current?.();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          languageFor(type),
          baseTheme,
          readOnlyComp.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (u.transactions.some((tr) => tr.annotation(Remote))) return;
            queueEdit(name, u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": `${name} source`, spellcheck: type === "markdown" ? "true" : "false" }),
          // Each visit (focus → blur) that changed the text is one canvas ⌘Z step;
          // inside the editor, ⌘Z stays the editor's own, keystroke by keystroke.
          EditorView.domEventHandlers({
            focus: (_e, v) => {
              visitStart.current = v.state.doc.toString();
            },
            blur: (_e, v) => {
              const start = visitStart.current;
              visitStart.current = null;
              if (start !== null) recordEdit(name, start, v.state.doc.toString());
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus && !readOnly) {
      requestAnimationFrame(() => {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        // The request is consumed once the editor actually has focus (the
        // editor loads lazily, so this can be well after the block mounted).
        if (useBoard.getState().focusRequest === name) useBoard.setState({ focusRequest: null });
      });
    }
    // Content from elsewhere (agent, other tab, revert). Our own unsent typing wins.
    const off = onBlockContent(name, (block) => {
      if (block.content === undefined || hasPendingEdit(name)) return;
      minimalReplace(view, block.content);
    });
    return () => {
      off();
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once per mount; content/readOnly updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, type]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyComp.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // A snapshot after reconnecting can carry newer content than this editor has.
  useEffect(() => {
    const view = viewRef.current;
    if (view && !hasPendingEdit(name) && view.state.doc.toString() !== content) minimalReplace(view, content);
  }, [content, name]);

  return <div ref={host} className={`code-editor nodrag nopan ${scrollable ? "nowheel" : ""}`} onKeyDown={(e) => e.stopPropagation()} />;
}
