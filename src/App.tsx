import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openDb, getSetting, setSetting, logActivity } from "./db";
import { startLibrary, flushSaves } from "./lib";
import { prefs, sound, confetti, toast } from "./fx";
import { useData, useVersion, loadDays, streakOf } from "./ui";
import Home from "./Home";
import Library from "./Library";
import Reader from "./Reader";
import Board from "./Board";
import Garden, { Plant } from "./Garden";
import Settings, { ThemePicker, applyTheme } from "./Settings";

export type View =
  | { name: "home" }
  | { name: "library"; folder: string }
  | { name: "reader"; fileId: number; page?: number }
  | { name: "board" }
  | { name: "garden" }
  | { name: "settings" };
export type Go = (v: View | { name: "back" }) => void;

const NAV: [View["name"], string, string][] = [
  ["home", "🏠", "Home"],
  ["library", "📚", "Library"],
  ["board", "🖍️", "Highlights"],
  ["garden", "🌷", "Garden"],
  ["settings", "⚙️", "Settings"],
];

export default function App() {
  // "loading" | "onboard" | "ok", or an error message
  const [ready, setReady] = useState<string>("loading");
  const [stack, setStack] = useState<View[]>([{ name: "home" }]);
  const view = stack[stack.length - 1];

  useEffect(() => {
    (async () => {
      await openDb();
      applyTheme((await getSetting("theme")) ?? "strawberry");
      prefs.sounds = (await getSetting("sounds")) !== "0";
      prefs.motion = (await getSetting("motion")) !== "0";
      document.documentElement.classList.toggle("calm", !prefs.motion);
      if (!(await getSetting("root"))) return setReady("onboard");
      setReady("ok");
      await startLibrary();
    })().catch((e) => setReady(`The app couldn't start: ${e}`));
    // Write pending highlights into PDFs before the window closes.
    const un = getCurrentWindow().onCloseRequested(() => flushSaves());
    return () => { un.then((f) => f()); };
  }, []);

  const go: Go = (v) => {
    if (v.name === "back") setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: "library", folder: "" }]));
    else setStack((s) => [...s.slice(-30), v]);
  };

  if (ready === "loading") return null;
  if (ready !== "onboard" && ready !== "ok")
    return <div className="onboard"><div className="card"><h1 className="hand">something went wrong</h1><p>{ready}</p></div></div>;
  if (ready === "onboard") return <Onboarding onDone={async () => { setReady("ok"); await startLibrary(); }} />;

  return (
    <div className="app">
      <aside className="side">
        <div className="logo hand">tbd ✿</div>
        {NAV.map(([name, ico, label]) => (
          <button key={name} className="nav" aria-current={view.name === name ? "page" : undefined}
            onClick={() => go(name === "library" ? { name, folder: "" } : ({ name } as View))}>
            <span className="ico">{ico}</span><span className={view.name === name ? "swipe" : ""}>{label}</span>
          </button>
        ))}
        <div className="side-foot">
          <FocusTimer fileId={view.name === "reader" ? view.fileId : 0} />
          <MiniStreak go={go} />
        </div>
      </aside>
      <main>
        {view.name === "home" && <Home go={go} />}
        {view.name === "library" && <Library key={view.folder} folder={view.folder} go={go} />}
        {view.name === "reader" && <Reader key={view.fileId + ":" + view.page} fileId={view.fileId} page={view.page} go={go} />}
        {view.name === "board" && <Board go={go} />}
        {view.name === "garden" && <Garden />}
        {view.name === "settings" && <Settings />}
      </main>
    </div>
  );
}

function MiniStreak({ go }: { go: Go }) {
  const v = useVersion();
  const streak = useData(async () => streakOf(await loadDays()), [v]) ?? 0;
  return (
    <button className="nav mini-streak" onClick={() => go({ name: "garden" })} aria-label={`${streak} day streak, open garden`}>
      <Plant streak={streak} size={34} /> {streak} day{streak === 1 ? "" : "s"}
    </button>
  );
}

const FOCUS_MIN = 25;
function FocusTimer({ fileId }: { fileId: number }) {
  const [end, setEnd] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!end) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [end]);
  useEffect(() => {
    if (end && now >= end) {
      setEnd(null);
      void logActivity(fileId, { focus: FOCUS_MIN });
      sound.chime();
      confetti();
      toast("Focus session done ✿ take a 5 minute break");
    }
  }, [now, end, fileId]);
  const left = end ? Math.max(0, end - now) : FOCUS_MIN * 60_000;
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <div className="timer">
      <div className="muted" style={{ fontSize: ".8rem", fontWeight: 700 }}>focus timer</div>
      <div className="t" aria-live="off">{mm}:{ss}</div>
      {end
        ? <button className="btn small ghost" onClick={() => setEnd(null)}>Stop</button>
        : <button className="btn small primary" onClick={() => { setEnd(Date.now() + FOCUS_MIN * 60_000); setNow(Date.now()); sound.tick(); }}>Start 25 min</button>}
    </div>
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [theme, setTheme] = useState("strawberry");

  async function pick() {
    const dir = await open({ directory: true, title: "Choose your notes folder" });
    if (typeof dir !== "string") return;
    await setSetting("nickname", name.trim());
    await setSetting("theme", theme);
    await setSetting("root", dir);
    sound.chime();
    onDone();
  }

  return (
    <div className="onboard">
      <div className="card">
        {step === 0 && <>
          <h1 className="hand">hi there ✿</h1>
          <p className="muted">This is a cozy place for your notes. First, what should it call you?</p>
          <input className="field" autoFocus placeholder="a name or nickname" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setStep(1)} aria-label="Your name" />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1.2rem" }}>
            <button className="btn primary" onClick={() => setStep(1)}>{name.trim() ? "Next" : "Skip"}</button>
          </div>
        </>}
        {step === 1 && <>
          <h1 className="hand">pick your stationery</h1>
          <p className="muted">You can change this any time in Settings.</p>
          <ThemePicker value={theme} onPick={(t) => { setTheme(t); applyTheme(t); sound.pop(); }} />
          <div className="row" style={{ justifyContent: "space-between", marginTop: "1.2rem" }}>
            <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
            <button className="btn primary" onClick={() => setStep(2)}>Next</button>
          </div>
        </>}
        {step === 2 && <>
          <h1 className="hand">where do your notes live?</h1>
          <p className="muted">
            Pick the folder with your PDFs. Its subfolders become notebooks here. Your files stay where they are,
            and highlights are saved into the PDFs themselves.
          </p>
          <div className="row" style={{ justifyContent: "space-between", marginTop: "1.2rem" }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary" onClick={pick}>Choose notes folder</button>
          </div>
        </>}
      </div>
    </div>
  );
}
