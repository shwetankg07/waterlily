import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnnotationMode, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { q, run, logActivity, parseHl, colors, type Color, type FileRow, type Highlight, type HighlightRow } from "./db";
import { readBytes, openPdf, importNew, markDirty, flushSaves, displayName, changed, pdfError, isImage, addNotePage } from "./lib";
import { toPdfRect, toViewBox, mergeLineRects, AUTHOR, NM_PREFIX, penOptions, type Rect } from "./pdfcore";
import { getStroke } from "perfect-freehand";
import { sound, sparkle, toast } from "./fx";
import { useVersion, useData, usePinch } from "./ui";
import ImageReader from "./ImageReader";
import type { Go } from "./App";

type Mode = "read" | "quiz" | "collapse";
type Pending = { x: number; y: number; parts: { page: number; rects: Rect[]; text: string }[] };
export type Active = { id: string; x: number; y: number };
/** The typed box being written: an existing one (id) or a new one (id null), with its box in PDF space. */
type Editing = { id: string | null; page: number; rect: Rect; text: string; size: number; hex: string };
/** A stroke in progress: points in PDF space, and the same points in page pixels for drawing. Pen points carry pressure: [x, y, pressure, …]. */
type Draft = { page: number; kind: "marker" | "pen"; pdf: number[]; px: number[] };
type Row = HighlightRow & { source_key: string | null };
const NONE: Highlight[] = [];
const COLS = "id, file_id, page, rects, color_id, text, note, created_at, source_key, ink, width, kind, hex, size";
const putRow = (r: Row) => run(`INSERT OR REPLACE INTO highlights(${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [r.id, r.file_id, r.page, r.rects, r.color_id, r.text, r.note, r.created_at, r.source_key ?? null, r.ink, r.width, r.kind, r.hex, r.size]);
const byPos = (a: Highlight, b: Highlight) => a.page - b.page || a.created_at - b.created_at;
/** Rows that count as highlights (the Board, the garden, quizzes); handwriting and typing don't. */
const countsAsHighlight = (rows: { kind: string | null }[]) => rows.some((r) => r.kind !== "pen" && r.kind !== "text");

/** Keep a text box on its page: moved back inside, and never wider than the page. `view` is the page's [x0, y0, x1, y1]. */
function clampBox([a, b, c, d]: Rect, [x0, y0, x1, y1]: number[]): Rect {
  const w = Math.min(c - a, x1 - x0 - 16), h = d - b;
  const left = Math.max(x0 + 8, Math.min(a, x1 - 8 - w));
  const top = Math.min(y1 - 8, Math.max(d, y0 + 8 + Math.min(h, y1 - y0 - 16)));
  return [left, top - h, left + w, top];
}

/** A function that keeps one identity but always runs the latest render's version (so memoized pages don't re-render). */
function useStable<A extends unknown[], R>(f: (...a: A) => R) {
  const r = useRef(f);
  r.current = f;
  return useCallback((...a: A) => r.current(...a), []);
}

export type Tool = "select" | "highlight" | "marker" | "pen" | "eraser" | "text";
// The tool, colors and pen size stay picked when she opens the next PDF.
let lastTool: Tool = "select";
let lastPen: number | null = null;
let lastInk = "#2b2130";
let lastSize = 2.5;
let lastTextSize = 16;
const TEXT_SIZES: [number, string][] = [[12, "S"], [16, "M"], [22, "L"]];
/** Open the next PDF with this tool picked (a fresh note opens with the pen). */
export const preferTool = (t: Tool) => { lastTool = t; };
const MARKER_WIDTH = 12; // PDF points, about one line of text
/** Handwriting inks and nib sizes (PDF points). */
const INKS = ["#2b2130", "#1f3a8a", "#b8325e", "#0f7a5a", "#7a3db8", "#c2410c"];
const SIZES: [number, string][] = [[1.6, "fine"], [2.5, "medium"], [4, "bold"]];
const outlinePath = (o: number[][]) => (o.length ? "M" + o.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L") + " Z" : "");

// Outlines of pen strokes on screen, per stroke and zoom. A stroke never changes shape, so a page of
// handwriting is outlined once instead of on every redraw.
const penPaths = new Map<string, string>();
function penPath(h: Highlight, i: number, vp: { convertToViewportPoint(x: number, y: number): number[] }, scale: number) {
  const key = `${h.id}|${i}|${scale}`;
  let d = penPaths.get(key);
  if (d === undefined) {
    const st = h.ink![i], pts: number[][] = [];
    for (let j = 0; j + 1 < st.length; j += 3) { const [px, py] = vp.convertToViewportPoint(st[j], st[j + 1]); pts.push([px, py, st[j + 2] ?? 0.5]); }
    d = outlinePath(getStroke(pts, penOptions((h.width ?? 2.5) * scale)));
    if (penPaths.size > 30000) penPaths.clear();
    penPaths.set(key, d);
  }
  return d;
}

/** [x, y, p, x, y, p, …] -> [[x, y, p], …] */
function triples(v: number[]) {
  const out: number[][] = [];
  for (let i = 0; i + 2 < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]);
  return out;
}

/** The text position under a point, if it's inside a page's text layer. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | undefined, offset = 0;
  if (d.caretPositionFromPoint) { const c = d.caretPositionFromPoint(x, y); if (c) { node = c.offsetNode; offset = c.offset; } }
  else if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
  return node && node.nodeType === Node.TEXT_NODE && node.parentElement?.closest(".textLayer") ? { node, offset } : null;
}

/** Is PDF point (x, y) on this marker or pen stroke? */
function onStroke(h: Highlight, x: number, y: number, slop = 3) {
  const step = h.kind === "pen" ? 3 : 2;
  const r = (h.width ?? MARKER_WIDTH) / 2 + slop;
  return (h.ink ?? []).some((st) => {
    for (let i = 0; i + 1 < st.length; i += step) {
      const [ax, ay, bx, by] = [st[i], st[i + 1], st[i + step] ?? st[i], st[i + step + 1] ?? st[i + 1]];
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r) return true;
    }
    return false;
  });
}

/** Marker and pen strokes drawn over a page (or a crop of one): PDF-space points to viewport pixels. */
const Strokes = memo(function Strokes({ hls, vp, colorOf, dy = 0, quiz, revealed }: {
  hls: Highlight[]; vp: { convertToViewportPoint(x: number, y: number): number[]; width: number; height: number };
  colorOf: Map<number, string>; dy?: number; quiz?: boolean; revealed?: Set<string>;
}) {
  const inked = hls.filter((h) => h.ink?.length && h.kind !== "pen");
  const pens = hls.filter((h) => h.ink?.length && h.kind === "pen");
  const scale = (vp as unknown as { scale: number }).scale ?? 1;
  const paths = pens.flatMap((h) => h.ink!.map((_, i) => <path key={h.id + i} d={penPath(h, i, vp, scale)} fill={h.hex ?? "#2b2130"} />));
  const pensSvg = paths.length > 0 && <svg className="strokes ink" width={vp.width} height={vp.height} style={{ top: -dy }} aria-hidden>{paths}</svg>;
  if (!inked.length) return pensSvg || null;
  const line = (h: Highlight) => h.ink!.map((st, i) => {
    const pts: string[] = [];
    for (let j = 0; j + 1 < st.length; j += 2) { const [px, py] = vp.convertToViewportPoint(st[j], st[j + 1]); pts.push(`${px},${py}`); }
    if (pts.length === 1) pts.push(pts[0]);
    return <polyline key={h.id + i} points={pts.join(" ")} fill="none" stroke={colorOf.get(h.color_id)} strokeWidth={(h.width ?? MARKER_WIDTH) * scale}
      strokeLinecap="round" strokeLinejoin="round" />;
  });
  // Blended strokes tint the text like a real marker; in quiz mode unrevealed ones are solid so they hide it.
  const hidden = inked.filter((h) => quiz && !revealed?.has(h.id));
  const shown = inked.filter((h) => !hidden.includes(h));
  return <>
    {pensSvg}
    {shown.length > 0 && <svg className="strokes" width={vp.width} height={vp.height} style={{ top: -dy }} aria-hidden>{shown.flatMap(line)}</svg>}
    {hidden.length > 0 && <svg className="strokes solid" width={vp.width} height={vp.height} style={{ top: -dy }} aria-hidden>{hidden.flatMap(line)}</svg>}
  </>;
});

/** Grow a range to whole words, like a highlighter pen would. Returns true if it changed. */
const WORD = /[\p{L}\p{N}'’_-]/u;
function snapToWords(range: Range) {
  const { startContainer: sc, endContainer: ec, startOffset: so, endOffset: eo } = range;
  if (sc.nodeType === Node.TEXT_NODE) {
    const t = sc.textContent ?? "";
    let i = so;
    while (i > 0 && WORD.test(t[i - 1])) i--;
    range.setStart(sc, i);
  }
  if (ec.nodeType === Node.TEXT_NODE) {
    const t = ec.textContent ?? "";
    let i = eo;
    while (i < t.length && WORD.test(t[i])) i++;
    range.setEnd(ec, i);
  }
  return range.startOffset !== so || range.endOffset !== eo;
}

/**
 * Our overlay draws highlights, so hide the PDF's own copies of them. Every other annotation
 * (a professor's ink, stamps, comments) still renders with the page.
 */
const hidden = new WeakMap<PDFPageProxy, Promise<void>>();
function hideHighlights(doc: PDFDocumentProxy, page: PDFPageProxy) {
  let p = hidden.get(page);
  if (!p) {
    p = page.getAnnotations().then((annots) => {
      for (const a of annots)
        if (a.subtype === "Highlight" || a.titleObj?.str === AUTHOR) doc.annotationStorage.setValue(a.id, { noView: true });
    }).catch(() => {});
    hidden.set(page, p);
  }
  return p;
}

/** Opens PDFs in the PDF reader and photos of notes in the image viewer. */
export default function Reader(props: { fileId: number; page?: number; go: Go }) {
  const rel = useData(async () => (await q<{ rel: string }>(`SELECT rel FROM files WHERE id=$1`, [props.fileId]))[0]?.rel ?? "", [props.fileId]);
  if (rel === undefined) return null;
  return isImage(rel) ? <ImageReader {...props} /> : <PdfReader {...props} />;
}

function PdfReader({ fileId, page: startPage, go }: { fileId: number; page?: number; go: Go }) {
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
  const [tool, setToolState] = useState<Tool>(lastTool);
  const [pen, setPenState] = useState<number | null>(lastPen);
  const [ink, setInkState] = useState(lastInk);
  const [size, setSizeState] = useState(lastSize);
  const [editing, setEditing] = useState<Editing | null>(null);
  const setTool = (t: Tool) => { lastTool = t; setToolState(t); setPending(null); getSelection()?.removeAllRanges(); };
  const setPen = (c: number) => { lastPen = c; setPenState(c); };
  // Ink and text size also restyle the box being typed in.
  const setInk = (c: string) => { lastInk = c; setInkState(c); setEditing((ed) => ed && { ...ed, hex: c }); };
  const setSize = (w: number) => { lastSize = w; setSizeState(w); };
  const penColor = pen && cols.some((c) => c.id === pen) ? pen : cols[0]?.id;
  // The stroke being drawn lives in a ref (a quick flick can lift before React re-renders); the state copy draws it.
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  // What the pointer that went down is doing. Only that pointer moves or ends it: a palm or a second
  // finger landing or lifting mid-stroke is ignored.
  const drag = useRef<
    | { id: number; kind: "highlight"; anchor: { node: Node; offset: number } | null }
    | { id: number; kind: "stroke"; page: number; el: HTMLElement; pen: boolean }
    | { id: number; kind: "erase"; page: number; el: HTMLElement }
    | null>(null);
  const erased = useRef<string[]>([]);
  // Undo/redo: each step is the rows before and after a change.
  const undoStack = useRef<{ before: Row[]; after: Row[] }[]>([]);
  const redoStack = useRef<{ before: Row[]; after: Row[] }[]>([]);
  const [, setHistoryTick] = useState(0);
  const [gen, setGen] = useState(0); // bumps when a note gets a new page and must be reopened
  const [textSize, setTextSizeState] = useState(lastTextSize);
  const setTextSize = (n: number) => { lastTextSize = n; setTextSizeState(n); setEditing((ed) => ed && { ...ed, size: n }); };
  const jumpTo = useRef<number | null>(null);
  const justDrew = useRef(false);
  const hadEditor = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastInput = useRef(Date.now());

  const colorOf = useMemo(() => new Map(cols.map((c) => [c.id, c.hex])), [cols]);
  // What's on screen is the database plus changes made here and still being written. A reload that
  // started before one of our writes finished could miss it, so it reads again instead of dropping it.
  const pendingAdds = useRef(new Map<string, Highlight>());
  const pendingDels = useRef(new Set<string>());
  const writes = useRef(0);
  const reloadSeq = useRef(0);
  const reloadHls = useCallback(async (): Promise<void> => {
    const seq = ++reloadSeq.current, w = writes.current;
    const rows = await q<HighlightRow>(`SELECT * FROM highlights WHERE file_id=$1 ORDER BY page, created_at`, [fileId]);
    if (seq !== reloadSeq.current) return; // a newer reload is on its way
    if (w !== writes.current) return reloadHls();
    const list = rows.map(parseHl).filter((h) => !pendingDels.current.has(h.id) && !pendingAdds.current.has(h.id));
    list.push(...pendingAdds.current.values());
    setHls(pendingAdds.current.size ? list.sort(byPos) : list);
  }, [fileId]);

  /** Add, replace and remove highlight rows: on screen at once, then in the database, then into the PDF. */
  async function change(add: Row[], del: string[]) {
    const hs = add.map(parseHl);
    const gone = new Set([...del, ...hs.map((h) => h.id)]);
    for (const h of hs) pendingAdds.current.set(h.id, h);
    for (const id of del) pendingDels.current.add(id);
    setHls((all) => (hs.length ? [...all.filter((h) => !gone.has(h.id)), ...hs].sort(byPos) : all.filter((h) => !gone.has(h.id))));
    try {
      const now = Date.now();
      for (const id of del) {
        // Remembered as gone (by our id and any other app's), so no later import brings it back.
        await run(`INSERT OR REPLACE INTO gone(file_id, key, at) SELECT $1, source_key, $3 FROM highlights WHERE id=$2 AND source_key IS NOT NULL`, [fileId, id, now]);
        await run(`INSERT OR REPLACE INTO gone(file_id, key, at) VALUES ($1, $2, $3)`, [fileId, NM_PREFIX + id, now]);
        await run(`DELETE FROM highlights WHERE id=$1`, [id]);
      }
      for (const r of add) {
        await run(`DELETE FROM gone WHERE file_id=$1 AND key IN ($2, $3)`, [fileId, NM_PREFIX + r.id, r.source_key ?? NM_PREFIX + r.id]);
        await putRow(r);
      }
    } finally {
      for (const h of hs) pendingAdds.current.delete(h.id);
      for (const id of del) pendingDels.current.delete(id);
      writes.current++;
    }
    await markDirty(fileId);
  }

  // Pages only re-render when their own highlights change: unchanged pages keep the same array.
  const lastByPage = useRef(new Map<number, Highlight[]>());
  const byPage = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of hls) { const a = m.get(h.page); if (a) a.push(h); else m.set(h.page, [h]); }
    for (const [p, a] of m) { const old = lastByPage.current.get(p); if (old && old.length === a.length && old.every((h, i) => h === a[i])) m.set(p, old); }
    lastByPage.current = m;
    return m;
  }, [hls]);
  // Pick up highlights imported in the background (e.g. made in another app) and renamed colors.
  useEffect(() => {
    void reloadHls();
    // Same colors: keep the same array, so pages (and their drawings) don't all redraw for nothing.
    void colors().then((n) => setCols((c) => (JSON.stringify(c) === JSON.stringify(n) ? c : n)));
  }, [v, reloadHls]);

  // Load the PDF and every page proxy (cheap; lets us lay out all pages before rendering any).
  useEffect(() => {
    let d: PDFDocumentProxy | undefined;
    let live = true;
    (async () => {
      const [f] = await q<FileRow>(`SELECT * FROM files WHERE id=$1`, [fileId]);
      if (!f) return live && go({ name: "back" });
      setFile(f);
      if (f.paper && !gen) setPanel(false); // a handwritten note has room to breathe; the Notes button brings the panel back
      if (gen) { setPages([]); setDoc(undefined); }
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
      setCur(Math.min(Math.max(1, jumpTo.current ?? startPage ?? f.last_page ?? 1), ps.length));
      jumpTo.current = null;
    })().catch((e) => toast(`Something went wrong opening this PDF: ${e}`));
    return () => {
      live = false;
      void flushSaves();
      void d?.loadingTask.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, gen]);

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
      // No changed(): nothing on screen shows progress while reading, and a reload of a big note isn't free.
      void run(`UPDATE files SET last_page=$2, max_page=max(max_page, $3) WHERE id=$1`, [fileId, n, seen]);
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
  // A resting palm plus a finger mustn't zoom while she writes.
  usePinch(scroller, zoomRef, () => Date.now() - penAt.current < 1500, [mode, doc]);

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
    lastInput.current = Date.now();
    if (drag.current) return; // already drawing: a resting palm or another finger doesn't interrupt
    pointerDown.current = true;
    downWasPalm.current = isPalm(e);
    justDrew.current = false;
    // A tap away from the box being typed in just finishes it (see onPageClick). A resting palm doesn't.
    hadEditor.current = editing !== null && !downWasPalm.current;
    if (hadEditor.current) (document.activeElement as HTMLElement | null)?.blur?.();
    // The eraser end of a stylus erases whatever tool is picked.
    const eraserEnd = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
    const t: Tool = eraserEnd ? "eraser" : tool;
    // Highlighter, marker, pen and eraser: mouse and stylus draw, fingers keep scrolling.
    if (mode !== "read" || t === "select" || t === "text" || e.pointerType === "touch" || (e.button !== 0 && !eraserEnd)) return;
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
    if (!pageEl || !pages[Number(pageEl.dataset.page) - 1]) return;
    e.preventDefault(); // no native text selection; we build it ourselves
    scroller.current?.setPointerCapture(e.pointerId);
    setPending(null);
    setActive(null);
    if (t === "highlight") {
      // Starting in the margin is fine: the selection begins at the first text the pen reaches.
      drag.current = { id: e.pointerId, kind: "highlight", anchor: caretAt(e.clientX, e.clientY) };
    } else if (t === "eraser") {
      drag.current = { id: e.pointerId, kind: "erase", page: Number(pageEl.dataset.page), el: pageEl };
      erased.current = [];
      eraseAt(e);
    } else {
      drag.current = { id: e.pointerId, kind: "stroke", page: Number(pageEl.dataset.page), el: pageEl, pen: t === "pen" };
      draftRef.current = null;
      addPoint(e);
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    markPen(e);
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    if (d.kind !== "highlight") return d.kind === "stroke" ? addPoint(e) : eraseAt(e);
    // Highlighter: select from where the pen went down to where it is now, snapped to words.
    const focus = caretAt(e.clientX, e.clientY);
    if (!focus) return;
    if (!d.anchor) { d.anchor = focus; return; }
    const a = d.anchor;
    const before = a.node === focus.node ? a.offset <= focus.offset : !!(a.node.compareDocumentPosition(focus.node) & Node.DOCUMENT_POSITION_FOLLOWING);
    const range = document.createRange();
    if (before) { range.setStart(a.node, a.offset); range.setEnd(focus.node, focus.offset); }
    else { range.setStart(focus.node, focus.offset); range.setEnd(a.node, a.offset); }
    snapToWords(range);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  function addPoint(e: React.PointerEvent) {
    const d = drag.current;
    if (d?.kind !== "stroke") return;
    lastInput.current = Date.now(); // writing counts as studying
    const kind: "pen" | "marker" = d.pen ? "pen" : "marker";
    const box = d.el.getBoundingClientRect();
    const vp = pages[d.page - 1].getViewport({ scale });
    // Styluses report points faster than the screen draws; the in-between ones arrive coalesced.
    const evs = e.nativeEvent.getCoalescedEvents?.().length ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    const pts = evs.map((ev) => {
      const x = ev.clientX - box.left, y = ev.clientY - box.top;
      const [px, py] = vp.convertToPdfPoint(x, y);
      // A stylus reports real pressure; a mouse gets a steady middle value.
      const pr = +(ev.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0.5).toFixed(2);
      return { x, y, px: +px.toFixed(1), py: +py.toFixed(1), pr };
    });
    let c = draftRef.current;
    if (!c || c.page !== d.page || c.kind !== kind) c = draftRef.current = { page: d.page, kind, pdf: [], px: [] };
    const step = kind === "pen" ? 3 : 2, before = c.pdf.length;
    const { pdf, px } = c;
    for (const p of pts) {
      const n = pdf.length;
      if (n && Math.hypot(p.px - pdf[n - step], p.py - pdf[n - step + 1]) < (kind === "pen" ? 0.5 : 1.5)) continue; // skip jitter
      if (kind === "pen") { pdf.push(p.px, p.py, p.pr); px.push(p.x, p.y, p.pr); } else { pdf.push(p.px, p.py); px.push(p.x, p.y); }
    }
    if (pdf.length !== before) setDraft({ ...c });
  }

  /** Eraser: whatever it touches (ink, marker, highlight) disappears; committed on lift so undo can bring it back. */
  function eraseAt(e: React.PointerEvent) {
    const d = drag.current;
    if (d?.kind !== "erase") return;
    const box = d.el.getBoundingClientRect();
    const [x, y] = pages[d.page - 1].getViewport({ scale }).convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    const hit = (byPage.get(d.page) ?? NONE).filter((h) => !erased.current.includes(h.id) &&
      (h.ink?.length ? onStroke(h, x, y, 4) : h.rects.some(([a, b, c, dd]) => x >= a && x <= c && y >= b && y <= dd)));
    if (!hit.length) return;
    const ids = new Set(hit.map((h) => h.id));
    for (const id of ids) { erased.current.push(id); pendingDels.current.add(id); } // a reload mid-rub mustn't bring them back
    setHls((all) => all.filter((h) => !ids.has(h.id)));
  }
  function onPointerUp(e: React.PointerEvent) {
    markPen(e);
    const d = drag.current;
    if (d && e.pointerId !== d.id) return; // a palm or another finger lifting doesn't end the stroke
    pointerDown.current = false;
    drag.current = null;
    if (downWasPalm.current) return;
    if (d?.kind === "stroke") return void finishStroke();
    if (d?.kind === "erase") {
      const gone = erased.current;
      erased.current = [];
      if (gone.length) { justDrew.current = true; void removeRows(gone); }
      return;
    }
    if (d?.kind === "highlight") {
      const got = selectionParts();
      if (got) { justDrew.current = true; void saveParts(got.parts, penColor, { x: e.clientX, y: e.clientY }); }
      return;
    }
    if (tool === "select") offerSelection();
  }
  function onPointerCancel(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) { pointerDown.current = false; return; }
    if (e.pointerId === d.id) onPointerUp(e); // keep what was drawn rather than lose it
  }

  async function finishStroke() {
    const st = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!st) return;
    const step = st.kind === "pen" ? 3 : 2, n = st.px.length;
    // A marker tap isn't a stroke: let the click open whatever is under it. The pen keeps dots (the i's and full stops).
    if (st.kind === "marker" && (n < 4 || (Math.hypot(st.px[0] - st.px[n - 2], st.px[1] - st.px[n - 1]) < 4 && n < 8))) return;
    if (st.kind === "pen" && n < 3) return;
    justDrew.current = true;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i + 1 < st.pdf.length; i += step) {
      x1 = Math.min(x1, st.pdf[i]); x2 = Math.max(x2, st.pdf[i]); y1 = Math.min(y1, st.pdf[i + 1]); y2 = Math.max(y2, st.pdf[i + 1]);
    }
    const pen = st.kind === "pen", w = pen ? size : MARKER_WIDTH;
    const row: Row = {
      id: crypto.randomUUID(), file_id: fileId, page: st.page, rects: JSON.stringify([[x1 - w, y1 - w, x2 + w, y2 + w]]),
      color_id: (pen ? cols[0]?.id : penColor) ?? 1, text: "", note: "", created_at: Date.now(), source_key: null,
      ink: JSON.stringify([st.pdf]), width: w, kind: pen ? "pen" : null, hex: pen ? ink : null, size: null,
    };
    // Undo steps are recorded in the order she made them. The stroke shows in the same frame the draft goes, so it never blinks.
    record([], [row]);
    await change([row], []);
    if (!pen) { await logActivity(fileId, { highlights: 1 }); sound.pop(); changed(); }
  }

  // ---------- undo / redo ----------
  const rowsOf = async (ids: string[]) =>
    ids.length ? q<Row>(`SELECT ${COLS} FROM highlights WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`, ids) : [];
  function record(before: Row[], after: Row[]) {
    undoStack.current.push({ before, after });
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
    setHistoryTick((t) => t + 1);
  }
  /** Make the database match `to`, given it currently matches `from`. */
  async function apply(from: Row[], to: Row[]) {
    await change(to, from.filter((r) => !to.some((t) => t.id === r.id)).map((r) => r.id));
    if (countsAsHighlight(from) || countsAsHighlight(to)) changed();
  }
  async function undo() {
    const step = undoStack.current.pop();
    if (!step) return;
    redoStack.current.push(step);
    setHistoryTick((t) => t + 1);
    await apply(step.after, step.before);
  }
  async function redo() {
    const step = redoStack.current.pop();
    if (!step) return;
    undoStack.current.push(step);
    setHistoryTick((t) => t + 1);
    await apply(step.before, step.after);
  }
  async function removeRows(ids: string[]) {
    const before = await rowsOf(ids);
    record(before, []);
    await change([], ids);
    if (countsAsHighlight(before)) changed();
  }

  /** Save a typed box: create it, update it, or remove it if she cleared all the text. */
  const commitText = useStable(async (ed: Editing, text: string, rect: Rect) => {
    setEditing((cur) => (cur === ed ? null : cur));
    const words = text.replace(/\s+$/, "");
    const view = pages[ed.page - 1]?.view;
    if (view) rect = clampBox(rect, view);
    if (ed.id === null) {
      if (!words.trim()) return;
      const row: Row = {
        id: crypto.randomUUID(), file_id: fileId, page: ed.page, rects: JSON.stringify([rect]), color_id: cols[0]?.id ?? 1, text: words,
        note: "", created_at: Date.now(), source_key: null, ink: null, width: null, kind: "text", hex: ed.hex, size: ed.size,
      };
      record([], [row]);
      await change([row], []);
    } else if (!words.trim()) {
      await removeRows([ed.id]);
    } else {
      const [before] = await rowsOf([ed.id]);
      if (!before) return;
      const old = (JSON.parse(before.rects) as Rect[])[0];
      // Opening a box and leaving it alone isn't a change (its measured height can differ a hair at another zoom).
      if (before.text === words && before.hex === ed.hex && before.size === ed.size && old && [0, 2, 3].every((i) => Math.abs(old[i] - rect[i]) < 0.5)) return;
      const after = { ...before, text: words, rects: JSON.stringify([rect]), hex: ed.hex, size: ed.size };
      record([before], [after]);
      await change([after], []);
    }
  });

  async function addPage() {
    if (!(await addNotePage(fileId))) return;
    jumpTo.current = pages.length + 1;
    jumped.current = false;
    setGen((g) => g + 1);
  }

  /** The current text selection as highlight parts, one per page, snapped to whole words. */
  function selectionParts() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !scroller.current?.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0).cloneRange();
    // Show the whole-word selection she'll get. Only touch it when it changed: setting the
    // selection fires selectionchange, which calls back in here.
    if (snapToWords(range)) { sel.removeAllRanges(); sel.addRange(range); }
    const all = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!all.length) return null;
    const hs = all.map((r) => r.height).sort((a, b) => a - b);
    const median = hs[hs.length >> 1];
    const parts: Pending["parts"] = [];
    for (const el of scroller.current.querySelectorAll<HTMLElement>("[data-page]")) {
      const box = el.getBoundingClientRect();
      const n = Number(el.dataset.page);
      const vp = pages[n - 1].getViewport({ scale });
      const rects = all
        .filter((r) => r.height < median * 3 && r.top >= box.top - 2 && r.bottom <= box.bottom + 2 && r.left < box.right && r.right > box.left)
        // 1px of padding each side: pdf.js's invisible text boxes run a touch narrower than the glyphs.
        .map((r) => toPdfRect(vp, r.left - box.left - 1, r.top - box.top, r.width + 2, r.height));
      if (!rects.length) continue;
      const spans = [...el.querySelectorAll(".textLayer span")].filter((s) => sel.containsNode(s, true));
      parts.push({ page: n, rects: mergeLineRects(rects), text: spans.map((s) => s.textContent).join("").trim() });
    }
    if (!parts.length) return null;
    if (parts.length === 1) parts[0].text = sel.toString().replace(/\s+/g, " ").trim();
    return { parts, last: all[all.length - 1] };
  }

  function offerSelection() {
    if (mode !== "read" || tool !== "select") return;
    const got = selectionParts();
    if (!got) return;
    const { parts, last } = got;
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
    await saveParts(parts, colorId, at ?? { x, y });
  }

  async function saveParts(parts: Pending["parts"], colorId: number, at: { x: number; y: number }) {
    const rows: Row[] = parts.map((p) => ({
      id: crypto.randomUUID(), file_id: fileId, page: p.page, rects: JSON.stringify(p.rects), color_id: colorId, text: p.text,
      note: "", created_at: Date.now(), source_key: null, ink: null, width: null, kind: null, hex: null, size: null,
    }));
    getSelection()?.removeAllRanges();
    sparkle(at.x, at.y, colorOf.get(colorId));
    sound.pop();
    setFresh(new Set(rows.map((r) => r.id)));
    record([], rows);
    await change(rows, []);
    await logActivity(fileId, { highlights: 1 });
    changed();
  }

  // Number keys 1-9 pick a color for the current selection; Esc closes popovers.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if (e.key === "Escape") { setPending(null); setActive(null); }
      if (pending && /^[1-9]$/.test(e.key) && cols[+e.key - 1]) void createHighlight(cols[+e.key - 1].id);
      else if (!pending && (tool === "highlight" || tool === "marker") && /^[1-9]$/.test(e.key) && cols[+e.key - 1]) setPen(cols[+e.key - 1].id);
      else if (tool === "pen" && /^[1-9]$/.test(e.key) && INKS[+e.key - 1]) setInk(INKS[+e.key - 1]);
      if (!e.ctrlKey && !e.metaKey && mode === "read") {
        if (e.key === "v") setTool("select");
        if (e.key === "h") setTool("highlight");
        if (e.key === "m") setTool("marker");
        if (e.key === "p") setTool("pen");
        if (e.key === "e") setTool("eraser");
        if (e.key === "t") setTool("text");
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void (e.shiftKey ? redo() : undo()); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); void redo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom(1.15); }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); zoom(1 / 1.15); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });

  // ---------- clicking existing highlights (hit-test; highlights sit under the text layer) ----------

  const onPageClick = useStable((e: React.MouseEvent, n: number) => {
    if (justDrew.current) { justDrew.current = false; return; }
    if (hadEditor.current) { hadEditor.current = false; return; } // that tap finished the box being typed in
    if (downWasPalm.current || getSelection()?.isCollapsed === false || !pages[n - 1]) return;
    setPending(null);
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vp = pages[n - 1].getViewport({ scale });
    const [x, y] = vp.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    if (tool === "pen" || tool === "eraser") return;
    if (tool === "text" && mode === "read") {
      // Start a new box with its top-left where she tapped, laid out on screen (so a rotated page works too),
      // and kept on the page near an edge.
      const rect = toPdfRect(vp, e.clientX - box.left, e.clientY - box.top, 240 * scale, textSize * 1.5 * scale);
      setEditing({ id: null, page: n, rect: clampBox(rect, pages[n - 1].view), text: "", size: textSize, hex: ink });
      return;
    }
    // Newest first: it's drawn on top where highlights overlap.
    const hit = [...hls].reverse().find((h) => h.page === n && h.kind !== "pen" && h.kind !== "text" &&
      (h.ink?.length ? onStroke(h, x, y) : h.rects.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d)));
    if (!hit) { setActive(null); return; }
    if (mode === "quiz") {
      const s = new Set(revealed);
      s.has(hit.id) ? s.delete(hit.id) : s.add(hit.id);
      setRevealed(s);
      sound.tick();
      return;
    }
    setActive({ id: hit.id, x: Math.max(8, Math.min(e.clientX, innerWidth - 262)), y: e.clientY + 12 });
  });
  const editText = useStable((h: Highlight) =>
    setEditing({ id: h.id, page: h.page, rect: h.rects[0], text: h.text, size: h.size ?? 16, hex: h.hex ?? INKS[0] }));

  async function updateHl(id: string, patch: { color_id?: number; note?: string }) {
    const [before] = await rowsOf([id]);
    if (!before) return;
    const after = { ...before, ...patch };
    record([before], [after]);
    await change([after], []);
    changed();
  }

  async function deleteHl(id: string) {
    setActive(null);
    await removeRows([id]);
  }

  const activeHl = hls.find((h) => h.id === active?.id);
  const marks = hls.filter((h) => h.kind !== "pen" && h.kind !== "text"); // handwriting and typing aren't listed, quizzed or collapsed
  const quizCount = marks.filter((h) => revealed.has(h.id)).length;

  return (
    <div className="reader">
      <div className="rbar">
        <button className="btn small ghost" onClick={() => go({ name: "back" })} aria-label="Back">← Back</button>
        <span className="title" title={file?.rel}>{file ? displayName(file.rel) : "…"}</span>
        <span className="muted">page {cur} of {pages.length || "…"}</span>
        <span className="grow" />
        {mode === "read" && (
          <div className="tools" role="group" aria-label="Tool">
            <div className="seg">
              <button aria-pressed={tool === "select"} onClick={() => setTool("select")} title="Select text, then pick a color (V)" aria-label="Select">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M5 3l14 8-6 1.5L10 19z" /></svg>
              </button>
              <button aria-pressed={tool === "highlight"} onClick={() => setTool("highlight")} title="Highlighter: swipe over text (H)" aria-label="Highlighter">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></svg>
              </button>
              <button aria-pressed={tool === "marker"} onClick={() => setTool("marker")} title="Marker: draw freely (M)" aria-label="Marker">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21c3-1 5-4 8-4s3 2 6 2 4-3 4-3M15 4l5 5-8 8H7v-5z" /></svg>
              </button>
              <button aria-pressed={tool === "pen"} onClick={() => setTool("pen")} title="Pen: handwrite (P)" aria-label="Pen">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6M11 11a2 2 0 1 0 0 .01" /></svg>
              </button>
              <button aria-pressed={tool === "text"} onClick={() => setTool("text")} title="Text: tap the page and type (T)" aria-label="Text">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5h14M12 5v14M9 19h6" /></svg>
              </button>
              <button aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")} title="Eraser: rub out ink and highlights (E)" aria-label="Eraser">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H9L4 15a2 2 0 0 1 0-2.8L13.2 3a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L12 20M7 11l7 7" /></svg>
              </button>
            </div>
            <div className="seg">
              <button onClick={() => void undo()} disabled={!undoStack.current.length} title="Undo (Ctrl+Z)" aria-label="Undo">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
              </button>
              <button onClick={() => void redo()} disabled={!redoStack.current.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" /></svg>
              </button>
            </div>
            {(tool === "text" || editing) && (
              // Pressing these keeps the typing going (no focus change), and restyles the box being typed in.
              <div className="pens" onMouseDown={(e) => e.preventDefault()}>
                {INKS.map((c, i) => (
                  <button key={c} className="swatch small" style={{ background: c }} aria-pressed={(editing?.hex ?? ink) === c} title={`Text color ${i + 1}`} aria-label={`Text color ${i + 1}`} onClick={() => setInk(c)} />
                ))}
                {TEXT_SIZES.map(([n, label]) => (
                  <button key={label} className="nib" aria-pressed={(editing?.size ?? textSize) === n} title={`${label} text`} aria-label={`${label} text`} onClick={() => setTextSize(n)}>
                    <b style={{ fontSize: 8 + n / 3 }}>A</b>
                  </button>
                ))}
              </div>
            )}
            {tool === "pen" && !editing && (
              <div className="pens">
                {INKS.map((c, i) => (
                  <button key={c} className="swatch small" style={{ background: c }} aria-pressed={ink === c} title={`Ink ${i + 1}`} aria-label={`Ink color ${i + 1}`} onClick={() => setInk(c)} />
                ))}
                {SIZES.map(([w, label]) => (
                  <button key={label} className="nib" aria-pressed={size === w} title={`${label} nib`} aria-label={`${label} nib`} onClick={() => setSize(w)}>
                    <i style={{ width: w * 2.4, height: w * 2.4 }} />
                  </button>
                ))}
              </div>
            )}
            {(tool === "highlight" || tool === "marker") && (
              <div className="pens">
                {cols.map((c, i) => (
                  <button key={c.id} className="swatch small" style={{ background: c.hex }} aria-pressed={penColor === c.id}
                    title={`${c.name} (${i + 1})`} aria-label={`Pen color ${c.name}`} onClick={() => setPen(c.id)} />
                ))}
              </div>
            )}
          </div>
        )}
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === "read"} onClick={() => setMode("read")}>Read</button>
          <button aria-pressed={mode === "quiz"} onClick={() => { setMode("quiz"); setRevealed(new Set()); setPending(null); setActive(null); }}>Quiz me</button>
          <button aria-pressed={mode === "collapse"} onClick={() => { setMode("collapse"); setPending(null); setActive(null); }}>Only highlights</button>
        </div>
        {mode === "quiz" && <span className="muted">{quizCount}/{marks.length} revealed
          <button className="btn small ghost" onClick={() => setRevealed(quizCount === marks.length ? new Set() : new Set(marks.map((h) => h.id)))}>
            {quizCount === marks.length ? "hide all" : "show all"}</button></span>}
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
            {doc && <Collapsed doc={doc} pages={pages} hls={marks} colorOf={colorOf} onOpen={(n) => { setMode("read"); requestAnimationFrame(() => scrollToPage(n, false)); }} />}
          </div>
        ) : (
          <div className={`pages ${mode === "quiz" ? "cloze" : ""} tool-${mode === "read" ? tool : "select"}`} ref={scroller} onScroll={onScroll}
            onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove} onPointerCancel={onPointerCancel}>
            {!pages.length && <div className="empty"><p className="hand">opening…</p></div>}
            {doc && scale > 0 && pages.map((p, i) => {
              const d = draft?.page === i + 1 ? draft : null;
              return <PdfPage key={i} doc={doc} page={p} n={i + 1} scale={scale} root={scroller}
                hls={byPage.get(i + 1) ?? NONE} colorOf={colorOf} mode={mode} revealed={revealed} fresh={fresh}
                editing={editing?.page === i + 1 ? editing : null} onEditText={editText} onCommitText={commitText}
                canEditText={mode === "read" && (tool === "select" || tool === "text" || tool === "highlight")}
                draft={d} draftColor={d ? (d.kind === "pen" ? ink : colorOf.get(penColor ?? 0)) : undefined} draftWidth={d?.kind === "pen" ? size : MARKER_WIDTH}
                onClick={onPageClick} />;
            })}
            {file?.paper && pages.length > 0 && mode === "read" && (
              <button className="add-page" onClick={() => void addPage()}>＋ Add a page</button>
            )}
            {pages.length > 0 && marks.length === 0 && mode === "quiz" && <div className="empty"><p className="hand">nothing to quiz yet</p><p className="muted">Highlight something in Read mode first.</p></div>}
          </div>
        )}

        {panel && (
          <aside className="panel" aria-label="Highlights in this PDF">
            <h2 className="hand" style={{ marginBottom: ".6rem" }}>{marks.length ? `${marks.length} highlight${marks.length > 1 ? "s" : ""}` : "no highlights yet"}</h2>
            {!marks.length && <p className="muted">Select text on the page, then pick a color. Keys 1–{cols.length} work too.</p>}
            {marks.map((h) => (
              <button key={h.id} className="note-card" style={{ ["--hc" as string]: colorOf.get(h.color_id) }}
                onClick={() => { setMode(mode === "collapse" ? "read" : mode); requestAnimationFrame(() => scrollToPage(h.page)); }}>
                <div className="q">{mode === "quiz" && !revealed.has(h.id) ? "▒▒▒▒ ▒▒▒ ▒▒▒▒▒" : h.text || (h.ink ? "✎ marker stroke" : "(highlight)")}</div>
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

export function HighlightPop({ hl, cols, at, onColor, onNote, onDelete, onClose }: {
  hl: Highlight; cols: Color[]; at: Active; onColor: (c: number) => void; onNote: (n: string) => void; onDelete: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState(hl.note);
  const latest = useRef(note);
  latest.current = note;
  const saved = useRef(hl.note);
  const deleted = useRef(false);
  const save = () => { if (!deleted.current && latest.current !== saved.current) { saved.current = latest.current; onNote(latest.current); } };
  // Save the note however the popover closes: Done, Esc, clicking elsewhere, leaving the PDF, closing the app.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), []);
  return (
    <div className="pop" style={{ left: at.x, top: Math.min(at.y, innerHeight - 220), width: 250 }}>
      <div className="swatches">
        {cols.map((c) => <button key={c.id} className="swatch" style={{ background: c.hex }} aria-pressed={hl.color_id === c.id} title={c.name} aria-label={c.name} onClick={() => onColor(c.id)} />)}
      </div>
      <textarea className="field" placeholder="Add a note…" value={note} autoFocus maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        // Focus moving to this popover's own buttons (a color, Delete) isn't leaving it.
        onBlur={(e) => { if (!e.currentTarget.closest(".pop")?.contains(e.relatedTarget as Node | null)) save(); }}
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

// Memoized: while she writes, only the page with the stroke in progress re-renders.
const PdfPage = memo(function PdfPage({ doc, page, n, scale, root, hls, colorOf, mode, revealed, fresh, draft, draftColor, draftWidth, onClick, editing, onEditText, onCommitText, canEditText }: {
  doc: PDFDocumentProxy; page: PDFPageProxy; n: number; scale: number; root: React.RefObject<HTMLDivElement | null>;
  hls: Highlight[]; colorOf: Map<number, string>; mode: Mode; revealed: Set<string>; fresh: Set<string>;
  draft: Draft | null; draftColor?: string; draftWidth: number;
  editing: Editing | null;
  onEditText: (h: Highlight) => void; onCommitText: (ed: Editing, text: string, rect: Rect) => void; canEditText: boolean;
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
        <Strokes hls={hls} vp={vp} colorOf={colorOf} quiz={mode === "quiz"} revealed={revealed} />
        {draft && draft.kind === "marker" && (
          <svg className="strokes" width={vp.width} height={vp.height} aria-hidden>
            <polyline points={draft.px.reduce((a, v, i) => a + (i % 2 ? `,${v} ` : `${v}`), "")} fill="none" stroke={draftColor}
              strokeWidth={draftWidth * scale} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {draft && draft.kind === "pen" && (
          <svg className="strokes ink" width={vp.width} height={vp.height} aria-hidden>
            <path d={outlinePath(getStroke(triples(draft.px), penOptions(draftWidth * scale)))} fill={draftColor} />
          </svg>
        )}
        {hls.filter((h) => !h.ink?.length && h.kind !== "text").flatMap((h) => h.rects.map((r, i) => {
          const b = toViewBox(vp, r);
          return <div key={h.id + i} className={`hl ${fresh.has(h.id) ? "fresh" : ""} ${revealed.has(h.id) ? "revealed" : ""}`}
            style={{ ...b, background: colorOf.get(h.color_id), opacity: mode === "quiz" && !revealed.has(h.id) ? 1 : undefined }} />;
        }))}
      </div>
      <div className={`textboxes ${canEditText ? "" : "passive"}`}>
        {hls.filter((h) => h.kind === "text" && h.id !== editing?.id).map((h) => {
          const b = toViewBox(vp, h.rects[0]);
          return (
            <div key={h.id} className="tbox" style={{ left: b.left, top: b.top, width: b.width, fontSize: (h.size ?? 16) * scale, color: h.hex ?? undefined }}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEditText(h); }}>{h.text}</div>
          );
        })}
        {editing && <TextEditor key={editing.id ?? "new"} ed={editing} vp={vp} scale={scale} view={page.view} onDone={onCommitText} />}
      </div>
      <div className="textLayer" ref={text}
        onMouseDown={(e) => e.currentTarget.classList.add("selecting")}
        onMouseUp={(e) => e.currentTarget.classList.remove("selecting")} />
    </div>
  );
});

/**
 * Typing on the page: a textarea that grows with its text. Drag the dotted handle to move the box and
 * its right edge to resize it; Esc or clicking elsewhere saves.
 */
function TextEditor({ ed, vp, scale, view, onDone }: {
  ed: Editing; vp: PageViewportLike; scale: number; view: number[]; onDone: (ed: Editing, text: string, rect: Rect) => void;
}) {
  const [text, setText] = useState(ed.text);
  const [rect, setRect] = useState<Rect>(ed.rect);
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const b = toViewBox(vp, rect);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const h = (area.current?.scrollHeight ?? b.height) + 4;
    onDone(ed, text, toPdfRect(vp, b.left, b.top, b.width, h));
  };
  // Leaving some other way (Back, another PDF, a mode switch) still keeps what she typed.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(), []);
  useEffect(() => { const a = area.current!; a.focus(); a.setSelectionRange(a.value.length, a.value.length); }, []);
  useEffect(() => { const a = area.current!; a.style.height = "0"; a.style.height = a.scrollHeight + "px"; }, [text, scale, rect, ed.size]);
  // Drag helpers: moving shifts the whole box, resizing changes its width. Worked out on screen (so a rotated
  // page behaves the same), then kept on the page.
  type Box = ReturnType<typeof toViewBox>;
  const dragWith = (e: React.PointerEvent, apply: (dx: number, dy: number, b: Box) => Box) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, b: toViewBox(vp, rect), id: e.pointerId };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== start.id) return;
      const nb = apply(ev.clientX - start.x, ev.clientY - start.y, start.b);
      setRect(clampBox(toPdfRect(vp, nb.left, nb.top, nb.width, nb.height), view));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== start.id) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      area.current?.focus();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  return (
    <div className="tbox editing" style={{ left: b.left, top: b.top, width: b.width }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <span className="tb-move" title="Drag to move" aria-label="Move text box" onPointerDown={(e) => dragWith(e, (dx, dy, b) => ({ ...b, left: b.left + dx, top: b.top + dy }))} />
      <textarea ref={area} value={text} rows={1} placeholder="Type here…" aria-label="Text on the page"
        style={{ fontSize: ed.size * scale, color: ed.hex }} onChange={(e) => setText(e.target.value)} onBlur={finish}
        onKeyDown={(e) => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); } }} />
      <span className="tb-size" title="Drag to resize" aria-label="Resize text box" onPointerDown={(e) => dragWith(e, (dx, _dy, b) => ({ ...b, width: Math.max(40 * scale, b.width + dx) }))} />
    </div>
  );
}
type PageViewportLike = Parameters<typeof toViewBox>[0];

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
        {h.ink?.length
          ? <Strokes hls={[h]} vp={vp} colorOf={new Map([[h.color_id, hex]])} dy={top} />
          : boxes.map((b, i) => <div key={i} className="hl" style={{ ...b, top: b.top - top, background: hex }} />)}
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
