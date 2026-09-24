import ReactDOM from "react-dom/client";
import "@fontsource-variable/nunito";
import "@fontsource-variable/caveat";
import "./styles.css";
import App from "./App";

// It's an app, not a web page: no reload (would drop unsaved notes), no printing the UI,
// and no browser right-click menu except where there's text to copy or edit.
if (import.meta.env.PROD) {
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "f5" || ((e.ctrlKey || e.metaKey) && (k === "r" || k === "p"))) e.preventDefault();
  });
  addEventListener("contextmenu", (e) => {
    const editable = (e.target as HTMLElement).closest?.("input, textarea");
    if (!editable && getSelection()?.isCollapsed !== false) e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
