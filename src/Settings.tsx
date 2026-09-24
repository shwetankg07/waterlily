import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { run, setSetting, colors, closeDb, openDb, getSetting, today } from "./db";
import { changed, startLibrary, getRoot } from "./lib";
import { prefs, toast, sound } from "./fx";
import { useData, useVersion } from "./ui";

export const THEMES: [id: string, name: string, colors: string][] = [
  ["strawberry", "Strawberry milk", "#ffd3e5, #ff7eb3"],
  ["lavender", "Lavender haze", "#e4dafe, #a98bff"],
  ["matcha", "Matcha latte", "#d3f0dc, #6cc58f"],
  ["peach", "Peach sorbet", "#ffe0cc, #ff9f6e"],
  ["midnight", "Midnight berry", "#2c2330, #ff8fc1"],
];

export function applyTheme(t: string) {
  document.documentElement.dataset.theme = t;
}

export function ThemePicker({ value, onPick }: { value: string; onPick: (t: string) => void }) {
  return (
    <div className="themes">
      {THEMES.map(([id, name, c]) => (
        <button key={id} className="theme-pick" data-theme={id} style={{ background: "var(--card)", color: "var(--ink)" }}
          aria-pressed={value === id} onClick={() => onPick(id)}>
          <i style={{ background: `linear-gradient(120deg, ${c})` }} />{name}
        </button>
      ))}
    </div>
  );
}

export default function Settings() {
  const v = useVersion();
  const d = useData(async () => ({
    nickname: (await getSetting("nickname")) ?? "",
    theme: (await getSetting("theme")) ?? "strawberry",
    cols: await colors(),
  }), [v]);
  const [nick, setNick] = useState<string>();
  const [armed, setArmed] = useState(false);
  if (!d) return null;

  const setPref = async (k: "sounds" | "motion", on: boolean) => {
    prefs[k] = on;
    document.documentElement.classList.toggle("calm", !prefs.motion);
    await setSetting(k, on ? "1" : "0");
    changed();
  };

  async function backup() {
    const path = await save({ defaultPath: `tbd-backup-${today()}.db`, filters: [{ name: "Backup", extensions: ["db"] }] });
    if (!path) return;
    try {
      await invoke("clear_backup_target", { path }); // the dialog already confirmed replacing it
      await run(`VACUUM INTO $1`, [path]);
      toast("Backup saved ✓");
    } catch (e) {
      toast(`Backup failed: ${e}`);
    }
  }

  async function restore() {
    if (!armed) return setArmed(true);
    setArmed(false);
    const path = await open({ filters: [{ name: "Backup", extensions: ["db"] }] });
    if (!path || typeof path !== "string") return;
    await closeDb();
    try {
      await invoke("restore_db", { src: path });
      location.reload();
    } catch (e) {
      await openDb(); // nothing was replaced; carry on with the current data
      toast(`Couldn't restore: ${e}`);
    }
  }

  async function pickRoot() {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await setSetting("root", dir);
    await startLibrary();
    toast("Notes folder changed");
  }

  return (
    <div className="page-wrap" style={{ maxWidth: 760 }}>
      <h1 className="hand"><span className="swipe">Settings</span></h1>

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>You</h2>
      <label className="dlg-sec" htmlFor="nick">What should the app call you?</label>
      <input id="nick" className="field" style={{ maxWidth: 320 }} value={nick ?? d.nickname} onChange={(e) => setNick(e.target.value)}
        onBlur={async () => { if (nick !== undefined) { await setSetting("nickname", nick.trim()); changed(); } }} />

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>Theme</h2>
      <ThemePicker value={d.theme} onPick={async (t) => { applyTheme(t); await setSetting("theme", t); sound.pop(); changed(); }} />

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>Highlighter colors</h2>
      <p className="muted">Give each color a meaning. Changing a color also recolors highlights in your PDFs the next time each one is saved.</p>
      <div style={{ display: "grid", gap: ".5rem", maxWidth: 420 }}>
        {d.cols.map((c, i) => (
          <div key={c.id} className="row" style={{ flexWrap: "nowrap" }}>
            <span className="muted" style={{ width: "1.2em" }}>{i + 1}</span>
            <input type="color" defaultValue={c.hex} aria-label={`${c.name} color`} style={{ width: 44, height: 34, border: 0, background: "none" }}
              onChange={async (e) => { await run(`UPDATE colors SET hex=$2 WHERE id=$1`, [c.id, e.target.value]); changed(); }} />
            <input className="field" defaultValue={c.name} aria-label={`Meaning of color ${i + 1}`}
              onBlur={async (e) => { await run(`UPDATE colors SET name=$2 WHERE id=$1`, [c.id, e.target.value.trim() || c.name]); changed(); }} />
          </div>
        ))}
        {d.cols.length < 9 && <button className="btn small" style={{ justifySelf: "start" }}
          onClick={async () => { await run(`INSERT INTO colors(name, hex) VALUES ('new color', '#ffd6a5')`); changed(); }}>Add a color</button>}
      </div>

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>Feel</h2>
      <label className="row"><input type="checkbox" checked={prefs.sounds} onChange={(e) => setPref("sounds", e.target.checked)} /> Little sounds</label>
      <label className="row"><input type="checkbox" checked={prefs.motion} onChange={(e) => setPref("motion", e.target.checked)} /> Animations and sparkles</label>

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>Notes folder</h2>
      <p className="muted" style={{ overflowWrap: "anywhere" }}>{getRoot()}</p>
      <button className="btn" onClick={pickRoot}>Choose a different folder</button>

      <h2 className="hand" style={{ marginTop: "1.6rem" }}>Backup</h2>
      <p className="muted">
        Your highlights are already saved inside your PDFs. A backup also keeps folder decorations, tags, notes, exam dates and your streak.
      </p>
      <div className="row">
        <button className="btn primary" onClick={backup}>Save a backup</button>
        <button className="btn" onClick={restore}>{armed ? "Choose backup file (replaces current data)" : "Restore from a backup"}</button>
        {armed && <button className="btn ghost" onClick={() => setArmed(false)}>Cancel</button>}
      </div>
    </div>
  );
}
