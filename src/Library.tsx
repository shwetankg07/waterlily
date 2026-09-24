import { useState, type DragEvent, type ReactNode } from "react";
import { q, run, type FileRow, type FolderRow, type Tag } from "./db";
import { dirs, parentOf, baseName, displayName, movePath, makeFolder, indexing, getRoot, changed } from "./lib";
import { useVersion, useData, Dialog, PASTELS, StickerPicker, imageToDataUrl, daysUntil } from "./ui";
import { sound } from "./fx";
import type { Go } from "./App";

type Target = { kind: "folder"; rel: string } | { kind: "file"; file: FileRow };

export default function Library({ folder, go }: { folder: string; go: Go }) {
  const v = useVersion();
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<number | null>(null);
  const [editing, setEditing] = useState<Target | null>(null);
  const [newFolder, setNewFolder] = useState(false);

  const data = useData(async () => {
    const [files, folders, tags, fileTags] = await Promise.all([
      q<FileRow>(`SELECT id, rel, pages, last_page, max_page, thumb, color, stickers, cover, missing, size, mtime FROM files WHERE missing=0`),
      q<FolderRow>(`SELECT * FROM folders`),
      q<Tag>(`SELECT * FROM tags ORDER BY name`),
      q<{ file_id: number; tag_id: number }>(`SELECT * FROM file_tags`),
    ]);
    return { files, folders: new Map(folders.map((f) => [f.rel, f])), tags, fileTags };
  }, [v]);

  if (!data) return null;
  const kids = dirs.filter((d) => parentOf(d) === folder);
  const inFolder = (rel: string, f: string) => rel.startsWith(f + "/");
  const shown = tagFilter
    ? data.files.filter((f) => data.fileTags.some((t) => t.file_id === f.id && t.tag_id === tagFilter))
    : data.files.filter((f) => parentOf(f.rel) === folder);
  shown.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  const tagsOf = (id: number) => data.tags.filter((t) => data.fileTags.some((ft) => ft.file_id === id && ft.tag_id === t.id));

  const crumbs = folder ? folder.split("/") : [];
  return (
    <div className="page-wrap">
      <div className="row" style={{ marginBottom: "1rem" }}>
        <input
          className="field grow" style={{ maxWidth: 420 }} placeholder="Search your notes, highlights and file names"
          value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search"
        />
        <button className="btn" onClick={() => setNewFolder(true)}>New folder</button>
        {indexing.left > 0 && <span className="muted">reading {indexing.left} new PDF{indexing.left > 1 ? "s" : ""}…</span>}
      </div>

      {query.trim() ? <SearchResults query={query} go={go} /> : (
        <>
          <nav className="crumbs" aria-label="Folder path">
            <DropTarget rel="" onGo={() => go({ name: "library", folder: "" })}>
              <span className="hand" style={{ fontSize: "1.5rem" }}>{baseName(getRoot()) || "Notes"}</span>
            </DropTarget>
            {crumbs.map((c, i) => {
              const rel = crumbs.slice(0, i + 1).join("/");
              return <span key={rel} className="row" style={{ gap: ".3rem" }}><span className="muted">/</span>
                <DropTarget rel={rel} onGo={() => go({ name: "library", folder: rel })}>{c}</DropTarget></span>;
            })}
          </nav>

          {data.tags.length > 0 && (
            <div className="row" style={{ marginBottom: ".4rem" }}>
              {data.tags.map((t) => (
                <button key={t.id} className="chip" style={{ background: t.color }} aria-pressed={tagFilter === null || tagFilter === t.id}
                  onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}>#{t.name}</button>
              ))}
              {tagFilter && <span className="muted">showing every PDF tagged #{data.tags.find((t) => t.id === tagFilter)?.name}</span>}
            </div>
          )}

          {!tagFilter && kids.length > 0 && (
            <div className="shelf">
              {kids.map((rel) => {
                const meta = data.folders.get(rel);
                const count = data.files.filter((f) => inFolder(f.rel, rel)).length;
                const left = meta?.exam_date ? daysUntil(meta.exam_date) : null;
                return (
                  <div key={rel} className="wrap-rel">
                    <Notebook rel={rel} meta={meta} onOpen={() => go({ name: "library", folder: rel })}>
                      <small>{count} PDF{count === 1 ? "" : "s"}</small>
                    </Notebook>
                    {left !== null && left >= 0 && (
                      <span className={`badge ${left <= 7 ? "soon" : ""}`} title={meta?.exam_label ?? "exam"}>
                        {left === 0 ? "exam today!" : `${meta?.exam_label || "exam"} in ${left}d`}
                      </span>
                    )}
                    <button className="dots-btn" aria-label={`Decorate ${baseName(rel)}`} onClick={() => setEditing({ kind: "folder", rel })}>⋯</button>
                  </div>
                );
              })}
            </div>
          )}

          {shown.length > 0 ? (
            <div className="shelf">
              {shown.map((f) => (
                <div key={f.id} className="wrap-rel">
                  <button className="paper" draggable onDragStart={(e) => dragData(e, f.rel, false)}
                    onClick={() => go({ name: "reader", fileId: f.id })}>
                    <div className="sheet" style={{ backgroundImage: `url(${f.cover ?? f.thumb ?? ""})`, ["--fc" as string]: f.color ?? "transparent" }}>
                      <span className="stickers">{f.stickers}</span>
                    </div>
                    <div className="name">{displayName(f.rel)}</div>
                    {f.pages > 0 && <div className="progress" title={`${Math.round((f.max_page / f.pages) * 100)}% read`}>
                      <i style={{ width: `${Math.min(100, (f.max_page / f.pages) * 100)}%` }} /></div>}
                    <div className="row" style={{ gap: ".25rem", marginTop: ".3rem" }}>
                      {tagsOf(f.id).map((t) => <span key={t.id} className="chip" style={{ background: t.color }}>#{t.name}</span>)}
                    </div>
                  </button>
                  <button className="dots-btn" aria-label={`Decorate ${displayName(f.rel)}`} onClick={() => setEditing({ kind: "file", file: f })}>⋯</button>
                </div>
              ))}
            </div>
          ) : kids.length === 0 && (
            <div className="empty">
              <p className="hand">nothing here yet</p>
              <p className="muted">Drop PDFs into this folder on your computer and they'll show up here.</p>
            </div>
          )}
        </>
      )}

      {editing && <Decorate target={editing} tags={data.tags} fileTags={data.fileTags}
        meta={editing.kind === "folder" ? data.folders.get(editing.rel) : undefined} onClose={() => setEditing(null)} />}
      {newFolder && <NewFolder parent={folder} onClose={() => setNewFolder(false)} />}
    </div>
  );
}

function dragData(e: DragEvent, rel: string, isDir: boolean) {
  e.dataTransfer.setData("application/x-tbd", JSON.stringify({ rel, isDir }));
  e.dataTransfer.effectAllowed = "move";
}

function useDrop(rel: string) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("application/x-tbd")) { e.preventDefault(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: async (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const d = JSON.parse(e.dataTransfer.getData("application/x-tbd") || "null");
        if (!d || parentOf(d.rel) === rel || d.rel === rel) return;
        const to = rel ? `${rel}/${baseName(d.rel)}` : baseName(d.rel);
        if (await movePath(d.rel, to, d.isDir)) sound.whoosh();
      },
    },
  };
}

function DropTarget({ rel, onGo, children }: { rel: string; onGo: () => void; children: ReactNode }) {
  const { over, props } = useDrop(rel);
  return <button className={over ? "drop" : ""} onClick={onGo} {...props}>{children}</button>;
}

function Notebook({ rel, meta, onOpen, children }: { rel: string; meta?: FolderRow; onOpen: () => void; children: ReactNode }) {
  const { over, props } = useDrop(rel);
  return (
    <button className={`nb ${over ? "drop" : ""}`} style={{ ["--c" as string]: meta?.color ?? PASTELS[hash(rel) % PASTELS.length] }}
      draggable onDragStart={(e) => dragData(e, rel, true)} onClick={onOpen} {...props}>
      {meta?.cover && <span className="cover" style={{ backgroundImage: `url(${meta.cover})` }} />}
      <span className="tape" />
      <span className="stickers">{meta?.stickers}</span>
      <span className="label">{baseName(rel)}{children}</span>
    </button>
  );
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function Decorate({ target, meta, tags, fileTags, onClose }: {
  target: Target; meta?: FolderRow; tags: Tag[]; fileTags: { file_id: number; tag_id: number }[]; onClose: () => void;
}) {
  const isFolder = target.kind === "folder";
  const rel = isFolder ? target.rel : target.file.rel;
  const cur = isFolder ? meta : target.file;
  const [name, setName] = useState(isFolder ? baseName(rel) : displayName(rel));
  const [color, setColor] = useState(cur?.color ?? null);
  const [stickers, setStickers] = useState(cur?.stickers ?? "");
  const [cover, setCover] = useState(cur?.cover ?? null);
  const [exam, setExam] = useState(meta?.exam_date ?? "");
  const [examLabel, setExamLabel] = useState(meta?.exam_label ?? "");
  const [myTags, setMyTags] = useState(() => new Set(isFolder ? [] : fileTags.filter((t) => t.file_id === target.file.id).map((t) => t.tag_id)));
  const [newTag, setNewTag] = useState("");

  async function save() {
    let at = rel;
    const wanted = isFolder ? name.trim() : name.trim() + ".pdf";
    if (name.trim() && wanted !== baseName(rel)) {
      const to = parentOf(rel) ? `${parentOf(rel)}/${wanted}` : wanted;
      if (await movePath(rel, to, isFolder)) at = to;
    }
    if (isFolder) {
      await run(`INSERT INTO folders(rel, color, stickers, cover, exam_date, exam_label) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(rel) DO UPDATE SET color=$2, stickers=$3, cover=$4, exam_date=$5, exam_label=$6`,
        [at, color, stickers, cover, exam || null, examLabel || null]);
    } else {
      const id = target.file.id;
      await run(`UPDATE files SET color=$2, stickers=$3, cover=$4 WHERE id=$1`, [id, color, stickers, cover]);
      await run(`DELETE FROM file_tags WHERE file_id=$1`, [id]);
      for (const t of myTags) await run(`INSERT INTO file_tags(file_id, tag_id) VALUES ($1, $2)`, [id, t]);
    }
    changed();
    sound.pop();
    onClose();
  }

  async function addTag() {
    const n = newTag.trim().replace(/^#/, "");
    if (!n) return;
    await run(`INSERT OR IGNORE INTO tags(name, color) VALUES ($1, $2)`, [n, PASTELS[hash(n) % PASTELS.length]]);
    const [t] = await q<Tag>(`SELECT * FROM tags WHERE name=$1`, [n]);
    tags.push(t);
    setMyTags(new Set([...myTags, t.id]));
    setNewTag("");
  }

  return (
    <Dialog onClose={onClose}>
      <h2 className="hand">Decorate {isFolder ? "notebook" : "page"}</h2>
      <label className="dlg-sec" htmlFor="dname">Name</label>
      <input id="dname" className="field" value={name} onChange={(e) => setName(e.target.value)} />

      <div className="dlg-sec">Color</div>
      <div className="row">
        {PASTELS.map((c) => <button key={c} className="swatch" style={{ background: c }} aria-pressed={color === c} aria-label={`color ${c}`} onClick={() => setColor(c)} />)}
        <button className="btn small ghost" onClick={() => setColor(null)}>none</button>
      </div>

      <div className="dlg-sec">Stickers (up to 3)</div>
      <StickerPicker value={stickers} onChange={setStickers} />

      <div className="dlg-sec">Cover picture</div>
      <div className="row">
        <label className="btn small">Choose a picture
          <input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCover(await imageToDataUrl(f)); }} />
        </label>
        {cover && <><img src={cover} alt="" style={{ height: 40, borderRadius: 6 }} /><button className="btn small ghost" onClick={() => setCover(null)}>remove</button></>}
      </div>

      {isFolder ? (
        <>
          <div className="dlg-sec">Exam countdown</div>
          <div className="row">
            <input type="date" className="field" style={{ width: "auto" }} value={exam} onChange={(e) => setExam(e.target.value)} aria-label="Exam date" />
            <input className="field grow" placeholder="e.g. mid-sem" value={examLabel} onChange={(e) => setExamLabel(e.target.value)} aria-label="Exam name" />
          </div>
        </>
      ) : (
        <>
          <div className="dlg-sec">Tags</div>
          <div className="row">
            {tags.map((t) => (
              <button key={t.id} className="chip" style={{ background: t.color }} aria-pressed={myTags.has(t.id)}
                onClick={() => { const s = new Set(myTags); s.has(t.id) ? s.delete(t.id) : s.add(t.id); setMyTags(s); }}>#{t.name}</button>
            ))}
            <input className="field" style={{ width: 150 }} placeholder="new tag" value={newTag}
              onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} aria-label="New tag" />
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: "1.4rem" }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Dialog>
  );
}

function NewFolder({ parent, onClose }: { parent: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const ok = name.trim() && !/[\\/:*?"<>|]/.test(name);
  const create = async () => { if (ok) { await makeFolder(parent, name.trim()); sound.pop(); onClose(); } };
  return (
    <Dialog onClose={onClose}>
      <h2 className="hand">New notebook</h2>
      <input className="field" autoFocus placeholder="e.g. Organic Chemistry" value={name}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} aria-label="Folder name" />
      {name && !ok && <p className="muted">Folder names can't contain \ / : * ? " &lt; &gt; |</p>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} onClick={create}>Create folder</button>
      </div>
    </Dialog>
  );
}

// ---------- search ----------

const S = "\u0001", E = "\u0002"; // snippet markers; split in React, never parsed as HTML
function Marked({ s }: { s: string }) {
  return <>{s.split(S).map((part, i) => {
    if (i === 0) return part;
    const [m, rest] = part.split(E);
    return <span key={i}><mark>{m}</mark>{rest}</span>;
  })}</>;
}

function SearchResults({ query, go }: { query: string; go: Go }) {
  const res = useData(async () => {
    const terms = query.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
    const like = `%${query.trim()}%`;
    const [names, pages, hls] = await Promise.all([
      q<{ id: number; rel: string }>(`SELECT id, rel FROM files WHERE missing=0 AND rel LIKE $1 LIMIT 20`, [like]),
      q<{ file_id: number; page: number; snip: string; rel: string }>(
        `SELECT p.file_id, p.page, snippet(page_text, 0, '${S}', '${E}', '…', 14) snip, f.rel
         FROM page_text p JOIN files f ON f.id = p.file_id WHERE page_text MATCH $1 AND f.missing=0 ORDER BY rank LIMIT 40`, [terms],
      ).catch(() => []),
      q<{ file_id: number; page: number; text: string; note: string; rel: string }>(
        `SELECT h.file_id, h.page, h.text, h.note, f.rel FROM highlights h JOIN files f ON f.id = h.file_id
         WHERE h.text LIKE $1 OR h.note LIKE $1 LIMIT 30`, [like]),
    ]);
    return { names, pages, hls };
  }, [query]);
  if (!res) return null;
  const none = !res.names.length && !res.pages.length && !res.hls.length;
  return (
    <div className="results">
      {none && <div className="empty"><p className="hand">no matches</p><p className="muted">Try a shorter word. PDFs that are still being read won't show up yet.</p></div>}
      {res.names.map((f) => <button key={"n" + f.id} className="result" onClick={() => go({ name: "reader", fileId: f.id })}>📄 <b>{displayName(f.rel)}</b> <span className="muted">{parentOf(f.rel)}</span></button>)}
      {res.hls.map((h, i) => <button key={"h" + i} className="result" onClick={() => go({ name: "reader", fileId: h.file_id, page: h.page })}>
        🖍️ {h.text}{h.note && <em className="muted"> ({h.note})</em>}<div className="muted">{displayName(h.rel)}, page {h.page}</div></button>)}
      {res.pages.map((p, i) => <button key={"p" + i} className="result" onClick={() => go({ name: "reader", fileId: p.file_id, page: p.page })}>
        <Marked s={p.snip} /><div className="muted">{displayName(p.rel)}, page {p.page}</div></button>)}
    </div>
  );
}
