import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { q, run, logActivity, parseHl, colors, type Color, type FileRow, type Highlight, type HighlightRow } from "./db";
import { imageUrl, displayName, changed } from "./lib";
import type { Rect } from "./pdfcore";
import { sound, sparkle, toast } from "./fx";
import { useVersion } from "./ui";
import { HighlightPop, type Active } from "./Reader";
import type { Go } from "./App";

// Photos of notes have no text to select, so highlights here are areas: drag a box with the
// mouse or a stylus. Rects are stored as fractions of the image, [x1, y1, x2, y2] with y down,
// so they stay put at any zoom. Fingers scroll instead of drawing, which keeps palms harmless.
type Box = { x1: number; y1: number; x2: number; y2: number };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export default function ImageReader({ fileId, go }: { fileId: number; page?: number; go: Go }) {
  const v = useVersion();
  const [file, setFile] = useState<FileRow>();
  const [src, setSrc] = useState<string>();
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<"read" | "quiz">("read");
  const [hls, setHls] = useState<Highlight[]>([]);
  const [cols, setCols] = useState<Color[]>([]);
  const [draft, setDraft] = useState<Box | null>(null);
  const [pending, setPending] = useState<{ rect: Rect; x: number; y: number } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const lastInput = useRef(Date.now());
  const penAt = useRef(0);
  const lastTouchPalm = useRef(false);

  const colorOf = useMemo(() => new Map(cols.map((c) => [c.id, c.hex])), [cols]);
  const reloadHls = useCallback(async () => {
    setHls((await q<HighlightRow>(`SELECT * FROM highlights WHERE file_id=$1 ORDER BY created_at`, [fileId])).map(parseHl));
  }, [fileId]);
  useEffect(() => {
    void reloadHls();
    void colors().then(setCols);
  }, [v, reloadHls]);

  useEffect(() => {
    let url = "";
    let live = true;
    (async () => {
      const [f] = await q<FileRow>(`SELECT * FROM files WHERE id=$1`, [fileId]);
      if (!f) return live && go({ name: "back" });
      setFile(f);
      // A photo is "read" as soon as it's opened.
      await run(`UPDATE files SET opened_at=$2, last_page=1, max_page=1 WHERE id=$1`, [fileId, Date.now()]);
      try {
        url = await imageUrl(f.rel);
      } catch (e) {
        if (live) { toast(`Couldn't open "${displayName(f.rel)}": ${e}`); go({ name: "back" }); }
        return;
      }
      if (!live) return URL.revokeObjectURL(url);
      setSrc(url);
      changed();
    })().catch((e) => toast(`Something went wrong opening this image: ${e}`));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  const W = natural ? natural.w * scale : 0, H = natural ? natural.h * scale : 0;

  function fit(img: HTMLImageElement) {
    const n = { w: img.naturalWidth, h: img.naturalHeight };
    setNatural(n);
    const room = (scroller.current?.clientWidth ?? 900) - 64;
    setScale(Math.min(2, room / n.w));
  }
  const zoom = (k: number) => setScale((s) => Math.min(6, Math.max(0.1, +(s * k).toFixed(3))));
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const f = (e: WheelEvent) => { if (e.ctrlKey) { e.preventDefault(); zoomRef.current(e.deltaY < 0 ? 1.1 : 1 / 1.1); } };
    el.addEventListener("wheel", f, { passive: false });
    return () => el.removeEventListener("wheel", f);
  }, []);

  // Passive reading time, same rule as PDFs.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput.current < 120_000)
        void logActivity(fileId, { seconds: 30 });
    }, 30_000);
    const poke = () => (lastInput.current = Date.now());
    addEventListener("mousemove", poke);
    addEventListener("keydown", poke);
    return () => { clearInterval(t); removeEventListener("mousemove", poke); removeEventListener("keydown", poke); };
  }, [fileId]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  function onPointerDown(e: React.PointerEvent) {
    lastInput.current = Date.now();
    if (e.pointerType === "pen") penAt.current = Date.now();
    if (e.pointerType === "touch") {
      lastTouchPalm.current = e.width * e.height > 40 * 40 || Date.now() - penAt.current < 1500;
      return; // fingers scroll
    }
    if (e.button !== 0) return;
    start.current = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (e.pointerType === "pen") penAt.current = Date.now();
    const s = start.current;
    if (!s || mode !== "read") return;
    const p = at(e);
    setDraft({ x1: s.x, y1: s.y, x2: p.x, y2: p.y });
  }
  function onPointerUp(e: React.PointerEvent) {
    const s = start.current;
    start.current = null;
    setDraft(null);
    if (!s) return;
    const p = at(e);
    if (mode !== "read" || (Math.abs(p.x - s.x) * W < 6 && Math.abs(p.y - s.y) * H < 6)) return tap(e, p);
    const rect: Rect = [Math.min(s.x, p.x), Math.min(s.y, p.y), Math.max(s.x, p.x), Math.max(s.y, p.y)];
    const width = cols.length * 34 + 24;
    setActive(null);
    setPending({ rect, x: Math.max(8, Math.min(e.clientX, innerWidth - width - 12)), y: Math.min(e.clientY + 10, innerHeight - 60) });
  }
  function onClick(e: React.MouseEvent) {
    // Mouse and pen taps are handled in onPointerUp; this catches finger taps.
    if ((e.nativeEvent as PointerEvent).pointerType !== "touch" || lastTouchPalm.current) return;
    tap(e, at(e));
  }

  function tap(e: { clientX: number; clientY: number }, p: { x: number; y: number }) {
    setPending(null);
    const hit = [...hls].reverse().find((h) => h.rects.some(([a, b, c, d]) => p.x >= a && p.x <= c && p.y >= b && p.y <= d));
    if (!hit) return setActive(null);
    if (mode === "quiz") {
      const s = new Set(revealed);
      s.has(hit.id) ? s.delete(hit.id) : s.add(hit.id);
      setRevealed(s);
      return sound.tick();
    }
    setActive({ id: hit.id, x: Math.max(8, Math.min(e.clientX, innerWidth - 262)), y: e.clientY + 12 });
  }

  async function createHighlight(colorId: number, where?: { x: number; y: number }) {
    if (!pending) return;
    const { rect, x, y } = pending;
    setPending(null);
    await run(
      `INSERT INTO highlights(id, file_id, page, rects, color_id, text, note, created_at) VALUES ($1,$2,1,$3,$4,'','',$5)`,
      [crypto.randomUUID(), fileId, JSON.stringify([rect]), colorId, Date.now()],
    );
    await logActivity(fileId, { highlights: 1 });
    sparkle(where?.x ?? x, where?.y ?? y, colorOf.get(colorId));
    sound.pop();
    await reloadHls();
    changed();
  }
  async function updateHl(id: string, patch: { color_id?: number; note?: string }) {
    if (patch.color_id !== undefined) await run(`UPDATE highlights SET color_id=$2 WHERE id=$1`, [id, patch.color_id]);
    if (patch.note !== undefined) await run(`UPDATE highlights SET note=$2 WHERE id=$1`, [id, patch.note]);
    await reloadHls();
    changed();
  }
  async function deleteHl(id: string) {
    setActive(null);
    await run(`DELETE FROM highlights WHERE id=$1`, [id]);
    await reloadHls();
    changed();
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if (e.key === "Escape") { setPending(null); setActive(null); }
      if (pending && /^[1-9]$/.test(e.key) && cols[+e.key - 1]) void createHighlight(cols[+e.key - 1].id);
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom(1.15); }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); zoom(1 / 1.15); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });

  const activeHl = hls.find((h) => h.id === active?.id);
  const quizCount = hls.filter((h) => revealed.has(h.id)).length;
  const boxStyle = (r: Rect) => ({ left: r[0] * W, top: r[1] * H, width: (r[2] - r[0]) * W, height: (r[3] - r[1]) * H });

  return (
    <div className="reader">
      <div className="rbar">
        <button className="btn small ghost" onClick={() => go({ name: "back" })} aria-label="Back">← Back</button>
        <span className="title" title={file?.rel}>{file ? displayName(file.rel) : "…"}</span>
        <span className="muted">photo</span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === "read"} onClick={() => setMode("read")}>Read</button>
          <button aria-pressed={mode === "quiz"} onClick={() => { setMode("quiz"); setRevealed(new Set()); setPending(null); setActive(null); }}>Quiz me</button>
        </div>
        {mode === "quiz" && <span className="muted">{quizCount}/{hls.length} revealed
          <button className="btn small ghost" onClick={() => setRevealed(quizCount === hls.length ? new Set() : new Set(hls.map((h) => h.id)))}>
            {quizCount === hls.length ? "hide all" : "show all"}</button></span>}
        <button className="btn small" onClick={() => zoom(1 / 1.15)} aria-label="Zoom out">−</button>
        <span className="muted" style={{ minWidth: "3.2em", textAlign: "center" }}>{Math.round(scale * 100)}%</span>
        <button className="btn small" onClick={() => zoom(1.15)} aria-label="Zoom in">+</button>
        <button className="btn small" aria-pressed={panel} onClick={() => setPanel(!panel)}>Notes</button>
      </div>

      <div className={`rbody ${panel ? "" : "nopanel"}`}>
        <div className={`pages ${mode === "quiz" ? "cloze" : ""}`} ref={scroller} onScroll={() => (lastInput.current = Date.now())}>
          {!src && <div className="empty"><p className="hand">opening…</p></div>}
          {src && (
            <div className={`imgpage ${mode}`} ref={box} style={natural ? { width: W, height: H } : { visibility: "hidden" }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerCancel={() => { start.current = null; setDraft(null); }} onClick={onClick}>
              <img src={src} alt={file ? displayName(file.rel) : ""} draggable={false} onLoad={(e) => fit(e.currentTarget)} />
              <div className="hl-layer">
                {hls.flatMap((h) => h.rects.map((r, i) => (
                  <div key={h.id + i} className={`hl ${revealed.has(h.id) ? "revealed" : ""}`}
                    style={{ ...boxStyle(r), background: colorOf.get(h.color_id), opacity: mode === "quiz" && !revealed.has(h.id) ? 1 : undefined }} />
                )))}
              </div>
              {draft && <div className="hl-draft" style={boxStyle([Math.min(draft.x1, draft.x2), Math.min(draft.y1, draft.y2), Math.max(draft.x1, draft.x2), Math.max(draft.y1, draft.y2)])} />}
            </div>
          )}
        </div>

        {panel && (
          <aside className="panel" aria-label="Highlights on this photo">
            <h2 className="hand" style={{ marginBottom: ".6rem" }}>{hls.length ? `${hls.length} highlight${hls.length > 1 ? "s" : ""}` : "no highlights yet"}</h2>
            {!hls.length && <p className="muted">Drag a box over any part of the photo with your mouse or stylus, then pick a color.</p>}
            {hls.map((h, i) => (
              <button key={h.id} className="note-card" style={{ ["--hc" as string]: colorOf.get(h.color_id) }}
                onClick={() => scroller.current?.scrollTo({ top: h.rects[0][1] * H - 80, behavior: "smooth" })}>
                <div className="q">Area {i + 1}</div>
                {h.note && <div className="n">{mode === "quiz" && !revealed.has(h.id) ? "▒▒▒▒ ▒▒▒" : h.note}</div>}
                <div className="muted" style={{ fontSize: ".78rem" }}>{cols.find((c) => c.id === h.color_id)?.name}</div>
              </button>
            ))}
          </aside>
        )}
      </div>

      {pending && (
        <div className="pop" style={{ left: pending.x, top: pending.y }} onMouseDown={(e) => e.preventDefault()}>
          <div className="swatches">
            {cols.map((c, i) => (
              <button key={c.id} className="swatch" style={{ background: c.hex }} title={`${c.name} (${i + 1})`} aria-label={`Highlight as ${c.name}`}
                onClick={(e) => createHighlight(c.id, { x: e.clientX, y: e.clientY })} />
            ))}
          </div>
        </div>
      )}
      {active && activeHl && (
        <HighlightPop key={activeHl.id} hl={activeHl} cols={cols} at={active}
          onColor={(c) => updateHl(activeHl.id, { color_id: c })} onNote={(n) => updateHl(activeHl.id, { note: n })}
          onDelete={() => deleteHl(activeHl.id)} onClose={() => setActive(null)} />
      )}
    </div>
  );
}
