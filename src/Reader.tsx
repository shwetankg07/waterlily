import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnnotationMode, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { q, run, logActivity, parseHl, colors, type Color, type FileRow, type Highlight, type HighlightRow } from "./db";
import { readBytes, openPdf, importNew, markDirty, flushSaves, displayName, changed, pdfError } from "./lib";
import { toPdfRect, toViewBox, mergeLineRects, type Rect } from "./pdfcore";
import { sound, sparkle, toast } from "./fx";
import { useVersion } from "./ui";
import type { Go } from "./App";

type Mode = "read" | "quiz" | "collapse";
type Pending = { x: number; y: number; parts: { page: number; rects: Rect[]; text: string }[] };
type Active = { id: string; x: number; y: number };

/**
 * Our overlay draws highlights, so hide the PDF's own copies of them. Every other annotation
 * (a professor's ink, stamps, comments) still renders with the page.
 */
const hidden = new WeakMap<PDFPageProxy, Promise<void>>();
function hideHighlights(doc: PDFDocumentProxy, page: PDFPageProxy) {
  let p = hidden.get(page);
  if (!p) {
    p = page.getAnnotations().then((annots) => {
      for (const a of annots) if (a.subtype === "Highlight") doc.annotationStorage.setValue(a.id, { noView: true });
    }).catch(() => {});
    hidden.set(page, p);
  }
  return p;
}

export default function Reader({ fileId, page: startPage, go }: { fileId: number; page?: number; go: Go }) {
  const v = useVersion();
  const [file, setFile] = useState<FileRow>();
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [scale, setScale] = useState(0);
  const [mode, setMode] = useState<Mode>("read");
  const [hls, setHls] = useState<Highlight[]>([]);
  const [cols, setCols] = useState<Color[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState(true);
  const [cur, setCur] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const lastInput = useRef(Date.now());

  const colorOf = useMemo(() => new Map(cols.map((c) => [c.id, c.hex])), [cols]);
  const reloadHls = useCallback(async () => {
    setHls((await q<HighlightRow>(`SELECT * FROM highlights WHERE file_id=$1 ORDER BY page, created_at`, [fileId])).map(parseHl));
  }, [fileId]);
  // Pick up highlights imported in the background (e.g. made in another app) and renamed colors.
  useEffect(() => {
    void reloadHls();
    void colors().then(setCols);
  }, [v, reloadHls]);

  // Load the PDF and every page proxy (cheap; lets us lay out all pages before rendering any).
  useEffect(() => {
    let d: PDFDocumentProxy | undefined;
    let live = true;
    (async () => {
      const [f] = await q<FileRow>(`SELECT * FROM files WHERE id=$1`, [fileId]);
      if (!f) return live && go({ name: "back" });
      setFile(f);
      await run(`UPDATE files SET opened_at=$2 WHERE id=$1`, [fileId, Date.now()]);
      let bytes: Uint8Array;
      try {
        bytes = await readBytes(f.rel);
        d = await openPdf(bytes);
      } catch (e) {
        if (!live) return;
        toast(`Couldn't open "${displayName(f.rel)}": ${pdfError(e)}`);
        return go({ name: "back" });
      }
      // Highlights made in another app since the last index show up right away.
      await importNew(fileId, bytes).catch(() => 0);
      await reloadHls();
      const doc = d;
      const ps = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
      if (!live) return void doc.loadingTask.destroy();
      const width = scroller.current?.clientWidth ?? 900;
      const maxW = Math.max(...ps.map((p) => p.getViewport({ scale: 1 }).width));
      setScale(Math.min(2.2, Math.max(0.6, (width - 64) / maxW)));
      setDoc(doc);
      setPages(ps);
      setCur(Math.min(Math.max(1, startPage ?? f.last_page ?? 1), ps.length));
    })().catch((e) => toast(`Something went wrong opening this PDF: ${e}`));
    return () => {
      live = false;
      void flushSaves();
      void d?.loadingTask.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Jump to the start page once laid out, then record it as read.
  const jumped = useRef(false);
  useEffect(() => {
    if (!pages.length || !scale || jumped.current) return;
    jumped.current = true;
    requestAnimationFrame(() => { scrollToPage(cur, false); requestAnimationFrame(trackPages); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, scale]);

  function scrollToPage(n: number, smooth = true) {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 16, behavior: smooth ? "smooth" : "auto" });
  }

  // Current page (a third of the way down) for the toolbar and "continue reading"; the furthest
  // page on screen counts toward progress, so short PDFs that never scroll still reach 100%.
  const saveProgress = useRef(0);
  const written = useRef({ page: 0, seen: 0 });
  function trackPages() {
    const s = scroller.current;
    if (!s) return;
    const mid = s.scrollTop + s.clientHeight / 3, bottom = s.scrollTop + s.clientHeight * 0.9;
    let n = 1, seen = 1;
    for (const el of s.querySelectorAll<HTMLElement>("[data-page]")) {
      if (el.offsetTop <= mid) n = Number(el.dataset.page);
      if (el.offsetTop <= bottom) seen = Number(el.dataset.page);
    }
    setCur(n);
    if (n === written.current.page && seen <= written.current.seen) return;
    clearTimeout(saveProgress.current);
    saveProgress.current = window.setTimeout(() => {
      written.current = { page: n, seen: Math.max(seen, written.current.seen) };
      run(`UPDATE files SET last_page=$2, max_page=max(max_page, $3) WHERE id=$1`, [fileId, n, seen]).then(changed);
    }, 800);
  }
  function onScroll() {
    lastInput.current = Date.now();
    trackPages();
  }

  // Zoom keeps you on the same page.
  function zoom(k: number) {
    setScale((s) => Math.min(4, Math.max(0.4, +(s * k).toFixed(2))));
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToPage(cur, false)));
  }
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Ctrl + wheel (and touchpad pinch) zooms. Needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const f = (e: WheelEvent) => { if (e.ctrlKey) { e.preventDefault(); zoomRef.current(e.deltaY < 0 ? 1.1 : 1 / 1.1); } };
    el.addEventListener("wheel", f, { passive: false });
    return () => el.removeEventListener("wheel", f);
  }, [mode, doc]);

  // Passive reading time: 30s ticks while the window is focused and she's been active recently.
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

  // ---------- creating highlights ----------

  // Palm rejection: while a stylus is near or was just used, finger/palm touches can't tap highlights or
  // start selections, and the page stops panning under the palm (see .pen-near in styles.css).
  const penAt = useRef(0);
  const penTimer = useRef(0);
  const pointerDown = useRef(false);
  const downWasPalm = useRef(false);
  const isPalm = (e: React.PointerEvent) =>
    e.pointerType === "touch" && (e.width * e.height > 40 * 40 || Date.now() - penAt.current < 1500);
  function markPen(e: React.PointerEvent) {
    if (e.pointerType !== "pen") return;
    penAt.current = Date.now();
    scroller.current?.classList.add("pen-near");
    clearTimeout(penTimer.current);
    penTimer.current = window.setTimeout(() => scroller.current?.classList.remove("pen-near"), 1500);
  }
  function onPointerDown(e: React.PointerEvent) {
    markPen(e);
    pointerDown.current = true;
    downWasPalm.current = isPalm(e);
    lastInput.current = Date.now();
  }
  function onPointerUp(e: React.PointerEvent) {
    markPen(e);
    pointerDown.current = false;
    if (downWasPalm.current) return;
    offerSelection();
  }

  function offerSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || mode !== "read" || !scroller.current?.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const all = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!all.length) return;
    const hs = all.map((r) => r.height).sort((a, b) => a - b);
    const median = hs[hs.length >> 1];
    const parts: Pending["parts"] = [];
    for (const el of scroller.current.querySelectorAll<HTMLElement>("[data-page]")) {
      const box = el.getBoundingClientRect();
      const n = Number(el.dataset.page);
      const vp = pages[n - 1].getViewport({ scale });
      const rects = all
        .filter((r) => r.height < median * 3 && r.top >= box.top - 2 && r.bottom <= box.bottom + 2 && r.left < box.right && r.right > box.left)
        .map((r) => toPdfRect(vp, r.left - box.left, r.top - box.top, r.width, r.height));
      if (!rects.length) continue;
      const spans = [...el.querySelectorAll(".textLayer span")].filter((s) => sel.containsNode(s, true));
      parts.push({ page: n, rects: mergeLineRects(rects), text: spans.map((s) => s.textContent).join("").trim() });
    }
    if (!parts.length) return;
    if (parts.length === 1) parts[0].text = sel.toString().replace(/\s+/g, " ").trim();
    const last = all[all.length - 1];
    const width = cols.length * 34 + 24;
    setActive(null);
    setPending({ x: Math.max(8, Math.min(last.right, innerWidth - width - 12)), y: Math.min(last.bottom + 8, innerHeight - 60), parts });
  }

  // Touch long-press selection and keyboard selection finish without a pointerup on the page.
  const offerRef = useRef(offerSelection);
  offerRef.current = offerSelection;
  useEffect(() => {
    let t = 0;
    const f = () => {
      clearTimeout(t);
      t = window.setTimeout(() => { if (!pointerDown.current) offerRef.current(); }, 350);
    };
    document.addEventListener("selectionchange", f);
    return () => { clearTimeout(t); document.removeEventListener("selectionchange", f); };
  }, []);

  async function createHighlight(colorId: number, at?: { x: number; y: number }) {
    if (!pending) return;
    const { parts, x, y } = pending;
    setPending(null);
    const ids: string[] = [];
    for (const p of parts) {
      const id = crypto.randomUUID();
      ids.push(id);
      await run(
        `INSERT INTO highlights(id, file_id, page, rects, color_id, text, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,'',$7)`,
        [id, fileId, p.page, JSON.stringify(p.rects), colorId, p.text, Date.now()],
      );
    }
    await markDirty(fileId);
    await logActivity(fileId, { highlights: 1 });
    getSelection()?.removeAllRanges();
    sparkle(at?.x ?? x, at?.y ?? y, colorOf.get(colorId));
    sound.pop();
    setFresh(new Set(ids));
    await reloadHls();
    changed();
  }

  // Number keys 1-9 pick a color for the current selection; Esc closes popovers.
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

  // ---------- clicking existing highlights (hit-test; highlights sit under the text layer) ----------

  function onPageClick(e: React.MouseEvent, n: number) {
    if (downWasPalm.current || getSelection()?.isCollapsed === false) return;
    setPending(null);
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const [x, y] = pages[n - 1].getViewport({ scale }).convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    // Newest first: it's drawn on top where highlights overlap.
    const hit = [...hls].reverse().find((h) => h.page === n && h.rects.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d));
    if (!hit) { setActive(null); return; }
    if (mode === "quiz") {
      const s = new Set(revealed);
      s.has(hit.id) ? s.delete(hit.id) : s.add(hit.id);
      setRevealed(s);
      sound.tick();
      return;
    }
    setActive({ id: hit.id, x: Math.max(8, Math.min(e.clientX, innerWidth - 262)), y: e.clientY + 12 });
  }

  async function updateHl(id: string, patch: { color_id?: number; note?: string }) {
    if (patch.color_id !== undefined) await run(`UPDATE highlights SET color_id=$2 WHERE id=$1`, [id, patch.color_id]);
    if (patch.note !== undefined) await run(`UPDATE highlights SET note=$2 WHERE id=$1`, [id, patch.note]);
    await markDirty(fileId);
    await reloadHls();
    changed();
  }

  async function deleteHl(id: string) {
    setActive(null);
    await run(`DELETE FROM highlights WHERE id=$1`, [id]);
    await markDirty(fileId);
    await reloadHls();
    changed();
  }

  const activeHl = hls.find((h) => h.id === active?.id);
  const quizCount = hls.filter((h) => revealed.has(h.id)).length;

  return (
    <div className="reader">
      <div className="rbar">
        <button className="btn small ghost" onClick={() => go({ name: "back" })} aria-label="Back">← Back</button>
        <span className="title" title={file?.rel}>{file ? displayName(file.rel) : "…"}</span>
        <span className="muted">page {cur} of {pages.length || "…"}</span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === "read"} onClick={() => setMode("read")}>Read</button>
          <button aria-pressed={mode === "quiz"} onClick={() => { setMode("quiz"); setRevealed(new Set()); setPending(null); setActive(null); }}>Quiz me</button>
          <button aria-pressed={mode === "collapse"} onClick={() => { setMode("collapse"); setPending(null); setActive(null); }}>Only highlights</button>
        </div>
        {mode === "quiz" && <span className="muted">{quizCount}/{hls.length} revealed
          <button className="btn small ghost" onClick={() => setRevealed(quizCount === hls.length ? new Set() : new Set(hls.map((h) => h.id)))}>
            {quizCount === hls.length ? "hide all" : "show all"}</button></span>}
        {mode !== "collapse" && <>
          <button className="btn small" onClick={() => zoom(1 / 1.15)} aria-label="Zoom out">−</button>
          <span className="muted" style={{ minWidth: "3.2em", textAlign: "center" }}>{Math.round(scale * 100)}%</span>
          <button className="btn small" onClick={() => zoom(1.15)} aria-label="Zoom in">+</button>
        </>}
        <button className="btn small" aria-pressed={panel} onClick={() => setPanel(!panel)}>Notes</button>
      </div>

      <div className={`rbody ${panel ? "" : "nopanel"}`}>
        {mode === "collapse" ? (
          <div className="pages">
            {doc && <Collapsed doc={doc} pages={pages} hls={hls} colorOf={colorOf} onOpen={(n) => { setMode("read"); requestAnimationFrame(() => scrollToPage(n, false)); }} />}
          </div>
        ) : (
          <div className={`pages ${mode === "quiz" ? "cloze" : ""}`} ref={scroller} onScroll={onScroll}
            onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={markPen}
            onPointerCancel={() => (pointerDown.current = false)}>
            {!pages.length && <div className="empty"><p className="hand">opening…</p></div>}
            {doc && scale > 0 && pages.map((p, i) => (
              <PdfPage key={i} doc={doc} page={p} n={i + 1} scale={scale} root={scroller}
                hls={hls.filter((h) => h.page === i + 1)} colorOf={colorOf} mode={mode} revealed={revealed} fresh={fresh}
                onClick={onPageClick} />
            ))}
            {pages.length > 0 && hls.length === 0 && mode === "quiz" && <div className="empty"><p className="hand">nothing to quiz yet</p><p className="muted">Highlight something in Read mode first.</p></div>}
          </div>
        )}

        {panel && (
          <aside className="panel" aria-label="Highlights in this PDF">
            <h2 className="hand" style={{ marginBottom: ".6rem" }}>{hls.length ? `${hls.length} highlight${hls.length > 1 ? "s" : ""}` : "no highlights yet"}</h2>
            {!hls.length && <p className="muted">Select text on the page, then pick a color. Keys 1–{cols.length} work too.</p>}
            {hls.map((h) => (
              <button key={h.id} className="note-card" style={{ ["--hc" as string]: colorOf.get(h.color_id) }}
                onClick={() => { setMode(mode === "collapse" ? "read" : mode); requestAnimationFrame(() => scrollToPage(h.page)); }}>
                <div className="q">{mode === "quiz" && !revealed.has(h.id) ? "▒▒▒▒ ▒▒▒ ▒▒▒▒▒" : h.text || "(highlight)"}</div>
                {h.note && <div className="n">{h.note}</div>}
                <div className="muted" style={{ fontSize: ".78rem" }}>p. {h.page}, {cols.find((c) => c.id === h.color_id)?.name}</div>
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

function HighlightPop({ hl, cols, at, onColor, onNote, onDelete, onClose }: {
  hl: Highlight; cols: Color[]; at: Active; onColor: (c: number) => void; onNote: (n: string) => void; onDelete: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState(hl.note);
  const latest = useRef(note);
  latest.current = note;
  const deleted = useRef(false);
  // Save the note however the popover closes: Done, Esc, clicking elsewhere, or leaving the PDF.
  useEffect(() => () => { if (!deleted.current && latest.current !== hl.note) onNote(latest.current); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);
  return (
    <div className="pop" style={{ left: at.x, top: Math.min(at.y, innerHeight - 220), width: 250 }}>
      <div className="swatches">
        {cols.map((c) => <button key={c.id} className="swatch" style={{ background: c.hex }} aria-pressed={hl.color_id === c.id} title={c.name} aria-label={c.name} onClick={() => onColor(c.id)} />)}
      </div>
      <textarea className="field" placeholder="Add a note…" value={note} autoFocus maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onClose();
        }} aria-label="Note" />
      <div className="row">
        <button className="btn small ghost" onClick={() => { deleted.current = true; onDelete(); }}>Delete highlight</button>
        <span className="grow" />
        <button className="btn small primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// Past ~16 megapixels a single canvas gets heavy (and at high zoom can exceed what the webview allows).
const MAX_CANVAS_PIXELS = 16e6;

function PdfPage({ doc, page, n, scale, root, hls, colorOf, mode, revealed, fresh, onClick }: {
  doc: PDFDocumentProxy; page: PDFPageProxy; n: number; scale: number; root: React.RefObject<HTMLDivElement | null>;
  hls: Highlight[]; colorOf: Map<number, string>; mode: Mode; revealed: Set<string>; fresh: Set<string>;
  onClick: (e: React.MouseEvent, n: number) => void;
}) {
  const vp = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  // Only pages near the viewport keep a canvas; far ones are freed.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "1000px 0px" });
    io.observe(box.current!);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current!, t = text.current!;
    if (!near) { c.width = c.height = 0; t.replaceChildren(); return; }
    let dead = false;
    let task: RenderTask | null = null;
    const k = Math.min(devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height)));
    void hideHighlights(doc, page).then(() => {
      if (dead) return;
      c.width = Math.floor(vp.width * k);
      c.height = Math.floor(vp.height * k);
      task = page.render({ canvas: c, viewport: vp, transform: k !== 1 ? [k, 0, 0, k, 0, 0] : undefined, annotationMode: AnnotationMode.ENABLE_STORAGE });
      task.promise.catch(() => {});
    });
    t.replaceChildren();
    const tl = new TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport: vp });
    tl.render().then(() => {
      const end = document.createElement("div");
      end.className = "endOfContent";
      t.append(end);
    }).catch(() => {});
    return () => { dead = true; task?.cancel(); tl.cancel(); };
  }, [near, vp, page, doc]);

  return (
    <div className="pdfpage" ref={box} data-page={n} onClick={(e) => onClick(e, n)}
      style={{ width: vp.width, height: vp.height, ["--total-scale-factor" as string]: scale, ["--scale-factor" as string]: scale }}>
      <canvas ref={canvas} />
      <div className="hl-layer">
        {hls.flatMap((h) => h.rects.map((r, i) => {
          const b = toViewBox(vp, r);
          return <div key={h.id + i} className={`hl ${fresh.has(h.id) ? "fresh" : ""} ${revealed.has(h.id) ? "revealed" : ""}`}
            style={{ ...b, background: colorOf.get(h.color_id), opacity: mode === "quiz" && !revealed.has(h.id) ? 1 : undefined }} />;
        }))}
      </div>
      <div className="textLayer" ref={text}
        onMouseDown={(e) => e.currentTarget.classList.add("selecting")}
        onMouseUp={(e) => e.currentTarget.classList.remove("selecting")} />
    </div>
  );
}

// ---------- "only highlights": crops of each highlight with adjustable context ----------

const CROP_W = 860;
function Collapsed({ doc, pages, hls, colorOf, onOpen }: {
  doc: PDFDocumentProxy; pages: PDFPageProxy[]; hls: Highlight[]; colorOf: Map<number, string>; onOpen: (n: number) => void;
}) {
  const images = useRef(new Map<number, Promise<string>>());
  const list = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(CROP_W);
  useEffect(() => {
    if (!list.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.min(CROP_W, Math.floor(e.contentRect.width)))));
    ro.observe(list.current);
    return () => ro.disconnect();
  }, [hls.length > 0]);
  useEffect(() => () => { for (const p of images.current.values()) void p.then(URL.revokeObjectURL, () => {}); }, []);
  const imageOf = useCallback((n: number) => {
    if (!images.current.has(n)) images.current.set(n, (async () => {
      const p = pages[n - 1];
      await hideHighlights(doc, p);
      const vp = p.getViewport({ scale: CROP_W / p.getViewport({ scale: 1 }).width * Math.min(devicePixelRatio || 1, 2) });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      await p.render({ canvas: c, viewport: vp, annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
      return URL.createObjectURL(await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("render failed"))), "image/jpeg", 0.9)));
    })());
    return images.current.get(n)!;
  }, [pages, doc]);
  const sorted = [...hls].sort((a, b) => a.page - b.page || Math.max(...b.rects.map((r) => r[3])) - Math.max(...a.rects.map((r) => r[3])));
  if (!sorted.length) return <div className="empty"><p className="hand">no highlights yet</p><p className="muted">Highlights you make in Read mode show up here, without the rest of the page.</p></div>;
  return <div className="collapse-list" ref={list}>{sorted.map((h) => pages[h.page - 1] &&
    <Crop key={h.id} h={h} w={w} page={pages[h.page - 1]} hex={colorOf.get(h.color_id) ?? "#ffe680"} imageOf={imageOf} onOpen={onOpen} />)}</div>;
}

function Crop({ h, w, page, hex, imageOf, onOpen }: { h: Highlight; w: number; page: PDFPageProxy; hex: string; imageOf: (n: number) => Promise<string>; onOpen: (n: number) => void }) {
  const [src, setSrc] = useState<string>();
  const [pad, setPad] = useState(28);
  const ref = useRef<HTMLDivElement>(null);
  const vp = useMemo(() => page.getViewport({ scale: w / page.getViewport({ scale: 1 }).width }), [page, w]);
  const boxes = h.rects.map((r) => toViewBox(vp, r));
  const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.top + b.height)) + pad);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { imageOf(h.page).then(setSrc, () => {}); io.disconnect(); }
    }, { rootMargin: "600px" });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [h.page, imageOf]);
  return (
    <div>
      <div className="crop" ref={ref} style={{ width: vp.width, height: bottom - top }} onClick={() => onOpen(h.page)}
        role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(h.page)} aria-label={`Open page ${h.page}`}>
        {src && <img src={src} alt="" style={{ top: -top, width: vp.width }} />}
        {boxes.map((b, i) => <div key={i} className="hl" style={{ ...b, top: b.top - top, background: hex }} />)}
        <span className="pg">p. {h.page}</span>
      </div>
      <div className="crop-meta">
        <span className="hand" style={{ fontSize: "1.15rem" }}>{h.note}</span>
        <span className="row" style={{ gap: ".3rem" }}>
          {pad > 28 && <button className="btn small ghost" onClick={() => setPad(28)}>Less</button>}
          <button className="btn small ghost" onClick={() => setPad(pad + 120)}>More context</button>
        </span>
      </div>
    </div>
  );
}
