import { useState } from "react";
import { q, colors } from "./db";
import { dirs, displayName, parentOf, isImage } from "./lib";
import { useData, useVersion } from "./ui";
import type { Go } from "./App";

interface Row { id: string; file_id: number; page: number; color_id: number; text: string; note: string; created_at: number; rel: string; inked: number }

export default function Board({ go }: { go: Go }) {
  const v = useVersion();
  const [off, setOff] = useState<Set<number>>(new Set());
  const [folder, setFolder] = useState("");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<"new" | "file">("new");
  const data = useData(async () => ({
    cols: await colors(),
    rows: await q<Row>(`SELECT h.id, h.file_id, h.page, h.color_id, h.text, h.note, h.created_at, f.rel, h.ink IS NOT NULL inked
      FROM highlights h JOIN files f ON f.id = h.file_id WHERE f.missing = 0`),
  }), [v]);
  if (!data) return null;

  const t = text.trim().toLowerCase();
  const rows = data.rows
    .filter((r) => !off.has(r.color_id))
    .filter((r) => !folder || r.rel.startsWith(folder + "/"))
    .filter((r) => !t || r.text.toLowerCase().includes(t) || r.note.toLowerCase().includes(t))
    .sort(sort === "new" ? (a, b) => b.created_at - a.created_at : (a, b) => a.rel.localeCompare(b.rel) || a.page - b.page);
  const hex = new Map(data.cols.map((c) => [c.id, c.hex]));

  return (
    <div className="page-wrap">
      <h1 className="hand"><span className="swipe">All highlights</span></h1>
      <p className="muted">Everything you've highlighted, across every PDF.</p>
      <div className="row" style={{ margin: "1rem 0 1.4rem" }}>
        {data.cols.map((c) => {
          const n = data.rows.filter((r) => r.color_id === c.id).length;
          return <button key={c.id} className="chip" style={{ background: c.hex, color: "#4a3340" }} aria-pressed={!off.has(c.id)}
            onClick={() => { const s = new Set(off); s.has(c.id) ? s.delete(c.id) : s.add(c.id); setOff(s); }}>{c.name} {n}</button>;
        })}
        <select className="field" style={{ width: "auto" }} value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
          <option value="">All folders</option>
          {dirs.map((d) => <option key={d} value={d}>{d.replaceAll("/", " › ")}</option>)}
        </select>
        <input className="field" style={{ width: 220 }} placeholder="Filter by words" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter" />
        <div className="seg" role="group" aria-label="Sort">
          <button aria-pressed={sort === "new"} onClick={() => setSort("new")}>Newest</button>
          <button aria-pressed={sort === "file"} onClick={() => setSort("file")}>By PDF</button>
        </div>
      </div>

      {rows.length ? (
        <div className="board">
          {rows.map((r) => (
            <button key={r.id} className="sticky" style={{ ["--hc" as string]: hex.get(r.color_id) }}
              onClick={() => go({ name: "reader", fileId: r.file_id, page: r.page })}>
              <div className="q">{r.text || (r.inked ? "✎ a marker stroke" : isImage(r.rel) ? "✿ a marked area on the photo" : "(highlight)")}</div>
              {r.note && <div className="n">{r.note}</div>}
              <div className="src">{displayName(r.rel)}, p. {r.page}{parentOf(r.rel) && `, in ${parentOf(r.rel)}`}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty">
          <p className="hand">{data.rows.length ? "nothing matches these filters" : "no highlights yet"}</p>
          <p className="muted">{data.rows.length ? "Turn a color back on or clear the filter." : "Open a PDF from the Library and select some text."}</p>
        </div>
      )}
    </div>
  );
}
