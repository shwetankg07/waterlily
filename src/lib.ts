import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// The legacy build carries polyfills, so an older WebView2 runtime on Windows still works.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { q, run, getSetting, parseHl, colors, type FileRow, type HighlightRow } from "./db";
import { readHighlights, writeHighlights, textInRects, hexToRgb, NM_PREFIX } from "./pdfcore";
import { toast } from "./fx";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Fired whenever library data changes; views re-query on it (see useVersion). */
export const changes = new EventTarget();
export const changed = () => changes.dispatchEvent(new Event("change"));
// Background work (indexing) announces progress at most this often, so views don't re-query per file.
let soonTimer = 0;
const changedSoon = () => { if (!soonTimer) soonTimer = window.setTimeout(() => { soonTimer = 0; changed(); }, 1500); };

let root = "";
export const getRoot = () => root;
export const abs = (rel: string) => (rel ? `${root.replace(/[\\/]+$/, "")}/${rel}` : root);
export const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
export const baseName = (rel: string) => rel.split("/").pop() ?? rel;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const isImage = (rel: string) => IMAGE.test(rel);
export const extOf = (rel: string) => rel.match(/\.[^./]+$/)?.[0] ?? "";
export const displayName = (rel: string) => baseName(rel).replace(/\.(pdf|png|jpe?g|webp|gif|bmp)$/i, "");
/** Blob URL for an image note (caller revokes it). */
export async function imageUrl(rel: string) {
  const type = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" }[extOf(rel).toLowerCase()] ?? "image/jpeg";
  return URL.createObjectURL(new Blob([(await readBytes(rel)) as BlobPart], { type }));
}
/** Last segment of the notes folder path, on any OS ("C:\Users\x\Notes" -> "Notes"). */
export const rootName = () => root.split(/[\\/]/).filter(Boolean).pop() ?? "Notes";
/** Set when the notes folder can't be read (moved, renamed, unplugged drive). */
export let rootMissing = false;

export async function readBytes(rel: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_file", { path: abs(rel) }));
}

// One pdf.js worker for every document, instead of spinning one up per file.
let worker: pdfjs.PDFWorker | null = null;
export function openPdf(bytes: Uint8Array) {
  worker ??= new pdfjs.PDFWorker();
  return pdfjs.getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer it's given
    worker,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
  }).promise;
}

/** Human wording for pdf.js / pdf-lib failures. */
export function pdfError(e: unknown) {
  const s = String((e as Error)?.name ?? "") + " " + String((e as Error)?.message ?? e);
  if (/Password/i.test(s)) return "this PDF is password-protected";
  if (/Encrypted/i.test(s)) return "this PDF is locked against editing, so its highlights stay in the app only";
  if (/Invalid ?PDF|Invalid PDF structure/i.test(s)) return "this file isn't a readable PDF";
  return s.trim();
}

async function sha256(bytes: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Scan { dirs: string[]; files: { rel: string; size: number; mtime: number }[] }
export let dirs: string[] = [];

/** Start (or restart) on a notes folder: scan, watch, index, and finish any interrupted saves. */
export async function startLibrary() {
  root = (await getSetting("root")) ?? "";
  if (!root) return;
  await sync();
  await invoke("watch", { root }).catch((e) => toast(`Changes on disk won't show up until you come back to the app: ${e}`));
}

let syncTimer = 0;
const syncSoon = () => { clearTimeout(syncTimer); syncTimer = window.setTimeout(sync, 600); };
void listen("fs-change", syncSoon);
// Fallback for folders the watcher can't follow (network drives, cloud folders): rescan on return.
addEventListener("focus", syncSoon);

let syncing: Promise<void> | null = null;
export function sync(): Promise<void> {
  // Serialize: one scan at a time.
  syncing = (syncing ?? Promise.resolve()).then(doSync).catch((e) => {
    rootMissing = true;
    changed();
    console.warn("scan failed", e);
  });
  return syncing;
}

async function doSync() {
  if (!root) return;
  const scan = await invoke<Scan>("scan", { root });
  rootMissing = false;
  dirs = scan.dirs.sort((a, b) => a.localeCompare(b));
  const known = await q<FileRow>(`SELECT * FROM files`);
  const byRel = new Map(known.map((f) => [f.rel, f]));
  const seen = new Set(scan.files.map((f) => f.rel));
  const gone = known.filter((f) => !seen.has(f.rel));

  for (const f of scan.files) {
    const row = byRel.get(f.rel);
    if (row) {
      if (row.missing || row.mtime !== f.mtime || row.size !== f.size)
        await run(`UPDATE files SET missing=0, mtime=$2, size=$3 WHERE id=$1`, [row.id, f.mtime, f.size]);
      continue;
    }
    // Unknown path: is it a file that moved while the app wasn't looking?
    let match = gone.find((g) => baseName(g.rel) === baseName(f.rel) && g.size === f.size);
    if (!match && gone.some((g) => g.hash)) {
      const h = await sha256(await readBytes(f.rel));
      match = gone.find((g) => g.hash === h);
    }
    if (match) {
      gone.splice(gone.indexOf(match), 1);
      await run(`UPDATE files SET rel=$2, missing=0, mtime=$3, size=$4 WHERE id=$1`, [match.id, f.rel, f.mtime, f.size]);
    } else {
      await run(`INSERT INTO files(rel, size, mtime, added_at) VALUES ($1, $2, $3, $4)`, [f.rel, f.size, f.mtime, Date.now()]);
    }
  }
  for (const g of gone) {
    if (g.missing) continue;
    const [{ n }] = await q<{ n: number }>(`SELECT count(*) n FROM highlights WHERE file_id=$1`, [g.id]);
    if (n) await run(`UPDATE files SET missing=1 WHERE id=$1`, [g.id]);
    else await forgetFile(g.id);
  }
  changed();
  void indexAll();
  // Retry saves that failed earlier (e.g. the PDF was open in another app, or moved).
  for (const { id } of await q<{ id: number }>(`SELECT id FROM files WHERE dirty>0 AND missing=0`))
    if (!saveTimers.has(id) && !inflight.has(id)) void queueSave(id);
}

async function forgetFile(id: number) {
  await run(`DELETE FROM files WHERE id=$1`, [id]);
  await run(`DELETE FROM file_tags WHERE file_id=$1`, [id]);
  await run(`DELETE FROM page_text WHERE file_id=$1`, [id]);
}

// ---------- background indexing: text for search, thumbnail, highlights from other apps ----------

export const indexing = { left: 0 };
let indexRunning = false;

async function indexAll() {
  if (indexRunning) return;
  indexRunning = true;
  try {
    for (;;) {
      const todo = await q<FileRow>(
        `SELECT * FROM files WHERE missing=0 AND (indexed_mtime IS NULL OR indexed_mtime != mtime) ORDER BY opened_at DESC, id`,
      );
      indexing.left = todo.length;
      changedSoon();
      if (!todo.length) break;
      // A PDF that hangs pdf.js mustn't stall the whole queue.
      const timeout = new Promise<never>((_, j) => setTimeout(() => j(new Error("timed out")), 180_000));
      await Promise.race([indexFile(todo[0]), timeout]).catch(async (e) => {
        console.warn("index failed", todo[0].rel, e);
        await run(`UPDATE files SET indexed_mtime=mtime WHERE id=$1`, [todo[0].id]); // don't retry until it changes
      });
    }
  } finally {
    indexRunning = false;
    changed();
  }
}

type Items = { str: string; transform: number[] }[];
const textItems = async (doc: pdfjs.PDFDocumentProxy, p: number) =>
  ((await (await doc.getPage(p)).getTextContent()).items.filter((i) => "str" in i) as Items);

async function indexFile(f: FileRow) {
  if (isImage(f.rel)) return indexImage(f);
  const bytes = await readBytes(f.rel);
  const doc = await openPdf(bytes);
  try {
    const items: Items[] = [];
    for (let p = 1; p <= doc.numPages; p++) items.push(await textItems(doc, p));
    const pageTexts = items.map((its) => its.map((i) => i.str).join(" "));
    await run(`DELETE FROM page_text WHERE file_id=$1`, [f.id]);
    for (let i = 0; i < pageTexts.length; i += 100) {
      const chunk = pageTexts.slice(i, i + 100);
      await run(
        `INSERT INTO page_text(text, file_id, page) VALUES ${chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(",")}`,
        chunk.flatMap((t, j) => [t, f.id, i + j + 1]),
      );
    }
    await importHighlights(f.id, bytes, async (p) => items[p - 1] ?? []);
    const thumb = f.thumb ?? (await renderThumb(doc));
    await run(`UPDATE files SET pages=$2, thumb=$3, hash=$4, indexed_mtime=$5 WHERE id=$1`, [
      f.id, doc.numPages, thumb, await sha256(bytes), f.mtime,
    ]);
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** Images: a thumbnail and a hash; there's no text to index and nothing inside to import. */
async function indexImage(f: FileRow) {
  const bytes = await readBytes(f.rel);
  let thumb = f.thumb;
  if (!thumb) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { resizeWidth: 360, resizeQuality: "medium" });
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    thumb = canvas.toDataURL("image/jpeg", 0.8);
  }
  await run(`UPDATE files SET pages=1, thumb=$2, hash=$3, indexed_mtime=$4 WHERE id=$1`, [f.id, thumb, await sha256(bytes), f.mtime]);
}

async function renderThumb(doc: pdfjs.PDFDocumentProxy) {
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 360 / vp.width });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // "print" renders without requestAnimationFrame, which pauses while the window is minimized.
  await page.render({ canvas, viewport, intent: "print", annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  return canvas.toDataURL("image/jpeg", 0.8);
}

/**
 * Pull highlights that exist in the PDF but not in the app (made in Edge/Adobe, or before a
 * reinstall). Returns how many were added. `textOf` supplies page text for the new ones.
 */
async function importHighlights(fileId: number, bytes: Uint8Array, textOf: (page: number) => Promise<Items>) {
  let found;
  try {
    found = await readHighlights(bytes);
  } catch {
    return 0; // encrypted or unparseable: nothing we can import
  }
  if (!found.length) return 0;
  const have = await q<{ id: string; source_key: string | null }>(`SELECT id, source_key FROM highlights WHERE file_id=$1`, [fileId]);
  const ids = new Set(have.map((h) => h.id));
  const keys = new Set(have.map((h) => h.source_key));
  const fresh = found.filter((h) => (h.ours ? !ids.has(h.key.slice(NM_PREFIX.length)) : !keys.has(h.key)));
  if (!fresh.length) return 0;
  const cols = await colors();
  const nearest = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    const d = (c: string) => { const [x, y, z] = hexToRgb(c); return (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2; };
    return cols.reduce((a, c) => (d(c.hex) < d(a.hex) ? c : a)).id;
  };
  for (const h of fresh) {
    await run(
      `INSERT OR IGNORE INTO highlights(id, file_id, page, rects, color_id, text, note, created_at, source_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [h.ours ? h.key.slice(NM_PREFIX.length) : crypto.randomUUID(), fileId, h.page, JSON.stringify(h.rects),
        nearest(h.hex), textInRects(await textOf(h.page), h.rects), h.note, Date.now(), h.ours ? null : h.key],
    );
  }
  return fresh.length;
}

/** Import highlights other apps added to this file, opening pdf.js only if there's text to fetch. */
export async function importNew(fileId: number, bytes: Uint8Array) {
  let doc: pdfjs.PDFDocumentProxy | null = null;
  try {
    return await importHighlights(fileId, bytes, async (p) => {
      doc ??= await openPdf(bytes);
      return textItems(doc, p);
    });
  } finally {
    void (doc as pdfjs.PDFDocumentProxy | null)?.loadingTask.destroy();
  }
}

// ---------- writing highlights back into the PDF ----------

const saveTimers = new Map<number, number>();
const inflight = new Map<number, Promise<void>>();
const warned = new Set<number>();

/** Call after any change to a file's highlights. Writes into the PDF shortly after. */
export async function markDirty(fileId: number) {
  await run(`UPDATE files SET dirty=dirty+1 WHERE id=$1`, [fileId]); // a counter: see saveNow
  clearTimeout(saveTimers.get(fileId));
  saveTimers.set(fileId, window.setTimeout(() => void queueSave(fileId), 1500));
}

/** Saves for one file run one after another, never overlapping. */
function queueSave(fileId: number) {
  saveTimers.delete(fileId);
  const next = (inflight.get(fileId) ?? Promise.resolve()).then(() => saveNow(fileId));
  inflight.set(fileId, next);
  void next.finally(() => { if (inflight.get(fileId) === next) inflight.delete(fileId); });
  return next;
}

/** Write every pending change now and wait for writes already running (before moves, on close). */
export async function flushSaves() {
  for (const [id, t] of saveTimers) { clearTimeout(t); void queueSave(id); }
  await Promise.all([...inflight.values()]);
}

async function pageCount(bytes: Uint8Array) {
  const doc = await openPdf(bytes);
  try { return doc.numPages; } finally { void doc.loadingTask.destroy(); }
}

async function saveNow(fileId: number) {
  const [f] = await q<FileRow>(`SELECT * FROM files WHERE id=$1`, [fileId]);
  if (!f || f.missing || !f.dirty) return;
  // Image files can't carry highlights inside them; theirs live in the app database only.
  if (isImage(f.rel)) return void run(`UPDATE files SET dirty=0 WHERE id=$1`, [fileId]);
  try {
    const bytes = await readBytes(f.rel);
    // The write below replaces every highlight in the file, so first take in any that
    // another app added since we last looked; otherwise they'd be lost.
    if (await importNew(fileId, bytes)) changed();
    const cols = new Map((await colors()).map((c) => [c.id, c.hex]));
    const hs = (await q<HighlightRow>(`SELECT * FROM highlights WHERE file_id=$1`, [fileId])).map(parseHl);
    const out = await writeHighlights(
      bytes,
      hs.map((h) => ({ id: h.id, page: h.page, rects: h.rects, hex: cols.get(h.color_id) ?? "#ffe680", note: h.note })),
    );
    // Never replace her file with something that doesn't open the same way.
    const [before, after] = await Promise.all([pageCount(bytes), pageCount(out)]);
    if (before !== after) throw new Error(`the rewritten file had ${after} pages instead of ${before}`);
    const mtime = await invoke<number>("write_pdf", out, {
      headers: { path: encodeURIComponent(abs(f.rel)), backup: String(f.id) },
    });
    // Our own write shouldn't trigger a re-index. Only clear the changes this write included:
    // an edit made while it ran bumped the counter and still gets its own save.
    await run(`UPDATE files SET mtime=$2, indexed_mtime=$2, size=$3, hash=$4, dirty=max(dirty-$5, 0) WHERE id=$1`, [
      fileId, mtime, out.length, await sha256(out), f.dirty,
    ]);
    warned.delete(fileId);
  } catch (e) {
    console.warn("save failed", f.rel, e);
    if (!warned.has(fileId)) toast(`Your highlights are safe in the app, but couldn't be saved into "${displayName(f.rel)}": ${pdfError(e)}`);
    warned.add(fileId);
  }
}

// ---------- file operations (moves go to disk; the watcher confirms) ----------

const prefixSwap = (table: string, col: string) =>
  `UPDATE ${table} SET ${col} = $2 || substr(${col}, length($1) + 1) WHERE ${col} = $1 OR substr(${col}, 1, length($1) + 1) = $1 || '/'`;

export async function movePath(fromRel: string, toRel: string, isDir: boolean) {
  if (fromRel === toRel) return;
  if (isDir && (toRel + "/").startsWith(fromRel + "/")) return toast("A folder can't go inside itself");
  await flushSaves(); // pending writes go to the old path before it moves
  try {
    await invoke("move_path", { from: abs(fromRel), to: abs(toRel) });
  } catch (e) {
    return toast(`Couldn't move "${baseName(fromRel)}": ${e}`);
  }
  if (isDir) {
    await run(prefixSwap("files", "rel"), [fromRel, toRel]);
    await run(prefixSwap("folders", "rel"), [fromRel, toRel]);
  } else await run(`UPDATE files SET rel=$2 WHERE rel=$1`, [fromRel, toRel]);
  await sync();
  return true;
}

export async function makeFolder(parentRel: string, name: string) {
  const rel = parentRel ? `${parentRel}/${name}` : name;
  try {
    await invoke("make_dir", { path: abs(rel) });
  } catch (e) {
    toast(`Couldn't create "${name}": ${e}`);
    return false;
  }
  await sync();
  return true;
}
