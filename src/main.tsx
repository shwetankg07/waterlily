import ReactDOM from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/standard-italic.css";
import "@fontsource/italiana";
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

// On a touchscreen with the keyboard folded away, the WebView doesn't always bring up Windows' on-screen
// keyboard by itself (a stylus tap, or a box the app focuses for her, like a new text box on a PDF). So when
// a text field gets focus soon after a finger or pen tap, ask for the keyboard explicitly. A physical
// keyboard or mouse changes nothing: the request is only made after a touch or pen.
const vk = (navigator as Navigator & { virtualKeyboard?: { show(): void; hide(): void } }).virtualKeyboard;
if (vk) {
  let touchedAt = 0;
  addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" || e.pointerType === "pen") touchedAt = Date.now(); }, true);
  const typable = (el: EventTarget | null): el is HTMLElement =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "file", "button", "submit", "range", "color"].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);
  addEventListener("focusin", (e) => {
    if (!typable(e.target) || Date.now() - touchedAt > 4000) return;
    e.target.setAttribute("virtualkeyboardpolicy", "manual"); // show() only works on fields that ask for it
    vk.show();
  });
  // With the manual policy the keyboard is ours to put away too, once focus has left every text field.
  addEventListener("focusout", (e) => {
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute("virtualkeyboardpolicy") !== "manual") return;
    setTimeout(() => { if (!typable(document.activeElement)) vk.hide(); }, 0);
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
