import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@xyflow/react/dist/base.css";
import "./styles/theme.css";
import "./styles/ui.css";
import "./styles/board.css";
import "./styles/blocks.css";
import "./styles/chat.css";
import "./styles/list.css";
import "./styles/navigation.css";
import "./styles/drawing.css";
import "./styles/mobile.css";
import { useRoute } from "./lib/router";
import { useSettings } from "./lib/settings";
import { Board } from "./pages/Board";
import { ProjectList } from "./pages/ProjectList";
import { RenderPage } from "./pages/RenderPage";
import { Toasts } from "./components/Toasts";
import { Tooltips } from "./components/Tooltips";
import { Logo } from "./components/Logo";
import { navigate } from "./lib/router";
import { setupViewport } from "./lib/viewport";

function useThemeAttribute() {
  const theme = useSettings((s) => s.theme);
  const fontSize = useSettings((s) => s.editorFontSize);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  }, [fontSize]);
}

function App() {
  useThemeAttribute();
  const route = useRoute();
  let page: React.ReactNode;
  switch (route.name) {
    case "list":
      page = <ProjectList />;
      break;
    case "board":
      page = <Board key={route.slug} slug={route.slug} />;
      break;
    case "render":
      page = <RenderPage slug={route.slug} block={route.block} />;
      break;
    default:
      page = (
        <div className="center-state">
          <div className="center-card">
            <Logo size={32} />
            <h2>Nothing here</h2>
            <button className="btn" onClick={() => navigate("/")}>All canvases</button>
          </div>
        </div>
      );
  }
  return (
    <>
      {page}
      <Toasts />
      <Tooltips />
    </>
  );
}

setupViewport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
