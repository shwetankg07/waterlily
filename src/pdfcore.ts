// Pure PDF helpers (no DOM, no Tauri) so they can be checked from node: scripts/check.mjs
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRef, PDFNumber, PDFStream, rgb, StandardFonts, type PDFFont } from "pdf-lib";
import { getStroke } from "perfect-freehand";

/** A rectangle in PDF user space: [x1, y1, x2, y2] with x1<x2, y1<y2. */
export type Rect = [number, number, number, number];

export interface WritableHighlight {
  id: string;
  page: number; // 1-based
  rects: Rect[]; // for marker strokes: their bounding box
  hex: string;
  note: string;
  /** Freehand strokes in PDF space. Marker: flat [x, y, …]. Pen: flat [x, y, pressure, …]. Absent for text highlights. */
  ink?: number[][] | null;
  width?: number | null;
  /** "pen" for handwriting, "text" for a typed box; anything else is a highlight or marker. */
  kind?: string | null;
  /** Typed boxes: the text and its font size in points (color comes from hex). */
  text?: string | null;
  size?: number | null;
}

/**
 * pdf-lib writes every object it loaded, referenced or not, so annotations we replace would pile up
 * in the file on every save. Keep only what the document can still reach.
 */
function dropUnreachable(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID];
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.toString())) continue;
      seen.add(o.toString());
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFDict) stack.push(...o.values());
    else if (o instanceof PDFArray) stack.push(...o.asArray());
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

/** Wrap text to a width with a font, keeping her own line breaks. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Pen handwriting options: pressure makes the line thicker, the ends taper slightly like real ink. */
export const penOptions = (width: number) => ({ size: width, thinning: 0.6, smoothing: 0.55, streamline: 0.4, simulatePressure: false });

/** Outline polygon of one pen stroke ([x, y, pressure, …]) as [[x, y], …]. */
export function penOutline(st: number[], width: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i + 1 < st.length; i += 3) pts.push([st[i], st[i + 1], st[i + 2] ?? 0.5]);
  return getStroke(pts, penOptions(width));
}

// ---------- paper for new notes ----------

export type Paper = "blank" | "lined" | "grid" | "dotted";
const A4: [number, number] = [595.28, 841.89];

/** Draw the paper pattern on a fresh page. Faint, so handwriting stays the star. */
function drawPaper(doc: PDFDocument, style: Paper) {
  const page = doc.addPage(A4);
  const [w, h] = A4;
  const faint = rgb(0.84, 0.8, 0.86);
  if (style === "lined") {
    for (let y = h - 90; y > 40; y -= 26) page.drawLine({ start: { x: 36, y }, end: { x: w - 36, y }, thickness: 0.6, color: faint });
    page.drawLine({ start: { x: 78, y: h - 40 }, end: { x: 78, y: 30 }, thickness: 0.8, color: rgb(0.96, 0.7, 0.78) });
  } else if (style === "grid") {
    for (let x = 36; x < w - 30; x += 18) page.drawLine({ start: { x, y: 36 }, end: { x, y: h - 36 }, thickness: 0.4, color: faint });
    for (let y = 36; y < h - 30; y += 18) page.drawLine({ start: { x: 36, y }, end: { x: w - 36, y }, thickness: 0.4, color: faint });
  } else if (style === "dotted") {
    for (let x = 36; x < w - 30; x += 18) for (let y = 36; y < h - 30; y += 18) page.drawCircle({ x, y, size: 0.9, color: faint });
  }
}

/** A brand-new one-page note on the chosen paper. */
export async function paperPdf(style: Paper): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Marks it as a note (and its paper) inside the file itself, so it's still one after a reinstall.
  doc.setKeywords([`waterlily-paper:${style}`]);
  drawPaper(doc, style);
  return doc.save();
}

/** Append one more page of paper to a note. */
export async function addPaperPage(bytes: Uint8Array, style: Paper): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  drawPaper(doc, style);
  return doc.save();
}

/** Author written on our annotations; pdf.js exposes it (it doesn't expose /NM), so the reader can spot our marker strokes. */
export const AUTHOR = "Waterlily";
const textOf = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "");

/**
 * Annotations we write carry this prefix in /NM so we recognise our own on re-read.
 * NEVER change it, not even when the app is renamed: highlights already written into
 * people's PDFs would stop being recognised and get imported a second time.
 */
export const NM_PREFIX = "tbd-";

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** QuadPoints (8 numbers per quad, any corner order) -> bounding rects. */
export function rectsFromQuads(q: number[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

/** Merge per-span rects into one rect per text line. */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const h = Math.min(r[3] - r[1], last ? last[3] - last[1] : Infinity);
    const overlapY = last ? Math.min(last[3], r[3]) - Math.max(last[1], r[1]) : 0;
    if (last && overlapY > h * 0.5 && r[0] <= last[2] + h) {
      out[out.length - 1] = [
        Math.min(last[0], r[0]), Math.min(last[1], r[1]),
        Math.max(last[2], r[2]), Math.max(last[3], r[3]),
      ];
    } else out.push([...r]);
  }
  return out;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const fmt2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Bounds of many points without spreading huge arrays into Math.min (which overflows the stack). */
function bounds(xs: number[], ys: number[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const x of xs) { if (x < x1) x1 = x; if (x > x2) x2 = x; }
  for (const y of ys) { if (y < y1) y1 = y; if (y > y2) y2 = y; }
  return Number.isFinite(x1 + y1 + x2 + y2) ? [x1, y1, x2, y2] : null;
}

/**
 * Drawn shapes of strokes, computed once and kept compressed. A stroke never changes after it's
 * drawn (only its color or note can), so every later save reuses its drawing instead of redoing
 * the pen outline and compressing it again.
 */
const drawings = new Map<string, { bytes: Uint8Array; bbox: number[] }>();
function cachedDrawing(key: string, make: () => { content: string; bbox: number[] } | null, doc: PDFDocument) {
  let d = drawings.get(key);
  if (!d) {
    const made = make();
    if (!made) return null;
    const raw = doc.context.flateStream(made.content);
    d = { bytes: raw.contents, bbox: made.bbox };
    if (drawings.size > 20000) drawings.clear();
    drawings.set(key, d);
  }
  return d;
}

/**
 * Replace every /Highlight annotation, and our own /Ink marker strokes, with the given ones.
 * Foreign highlights must already have been imported (see readHighlights), so dropping them
 * loses nothing. Other apps' ink is left alone. Popups of dropped annotations go too.
 */
export async function writeHighlights(bytes: Uint8Array, hs: WritableHighlight[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();

  pages.forEach((page) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    const dropped = new Set<string>();
    const keep: (PDFRef | PDFDict)[] = [];
    const entries = annots.asArray();
    const dictOf = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
    for (const o of entries) {
      const d = dictOf(o);
      if (!(d instanceof PDFDict)) continue;
      const sub = d.get(PDFName.of("Subtype"));
      const ours = textOf(d.lookup(PDFName.of("NM"))).startsWith(NM_PREFIX);
      if (sub === PDFName.of("Highlight") || ((sub === PDFName.of("Ink") || sub === PDFName.of("FreeText")) && ours)) dropped.add(String(o));
    }
    for (const o of entries) {
      if (dropped.has(String(o))) continue;
      const d = dictOf(o);
      const parent = d instanceof PDFDict ? d.get(PDFName.of("Parent")) : undefined;
      if (parent && dropped.has(String(parent))) continue;
      keep.push(o as PDFRef);
    }
    page.node.set(PDFName.of("Annots"), ctx.obj(keep));
  });

  const now = new Date();
  let helv: PDFFont | null = null;
  for (const h of hs) {
    const page = pages[h.page - 1];
    if (!page || !h.rects.length) continue;
    const [r, g, b] = hexToRgb(h.hex);
    const gs = { ExtGState: { GS0: { Type: "ExtGState", BM: "Multiply" } } };
    let annot: PDFDict;
    if (h.kind === "text") {
      // A typed box: /FreeText with the words in /Contents. The drawn text uses Helvetica, which covers
      // Latin text; for anything else (Hindi, emoji) other viewers draw it themselves from /Contents.
      const [x1, , x2, y2] = h.rects[0];
      let y1 = h.rects[0][1];
      const sz = h.size ?? 14;
      helv ??= await doc.embedFont(StandardFonts.Helvetica);
      let ap: PDFRef | null = null;
      try {
        const lines = wrap(h.text ?? "", helv, sz, x2 - x1 - 4);
        // Helvetica can wrap into more lines than the app's font did; grow the box so none get clipped.
        y1 = Math.min(y1, y2 - sz * (1.1 + (lines.length - 1) * 1.35) - sz * 0.5);
        const body = lines.map((l, i) => `1 0 0 1 2 ${fmt(y2 - y1 - sz * (1.1 + i * 1.35))} Tm ${helv!.encodeText(l).toString()} Tj`).join(" ");
        ap = ctx.register(ctx.stream(`BT /F1 ${fmt(sz)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${body} ET`, {
          Type: "XObject", Subtype: "Form", BBox: [0, 0, x2 - x1, y2 - y1], Matrix: [1, 0, 0, 1, x1, y1], Resources: { Font: { F1: helv.ref } },
        }));
      } catch { /* characters Helvetica can't draw: leave the drawing to the viewer */ }
      annot = ctx.obj({
        Type: "Annot", Subtype: "FreeText", P: page.ref, Rect: [x1, y1, x2, y2], F: 4, BS: { W: 0 },
        DA: PDFString.of(`/Helv ${fmt(sz)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`), WLColor: PDFString.of(h.hex), WLSize: sz,
        NM: PDFString.of(NM_PREFIX + h.id), T: PDFString.of(AUTHOR), M: PDFString.fromDate(now),
      });
      annot.set(PDFName.of("Contents"), PDFHexString.fromText(h.text ?? ""));
      if (ap) annot.set(PDFName.of("AP"), ctx.obj({ N: ap }));
    } else if (h.ink?.length && h.kind === "pen") {
      // Handwriting: the drawn shape is the pressure-varying outline, filled with solid ink. InkList keeps a
      // plain centerline for viewers that redraw ink themselves; /WLPoints keeps the exact pen data for us.
      const w = h.width ?? 2.5;
      const ink = h.ink;
      const drawing = cachedDrawing(`pen|${h.id}|${h.hex}|${w}`, () => {
        const outlines = ink.map((st) => penOutline(st, w)).filter((o) => o.length > 2);
        const bb = bounds(outlines.flatMap((o) => o.map((p) => p[0])), outlines.flatMap((o) => o.map((p) => p[1])));
        if (!bb) return null;
        const [ox, oy] = [bb[0] - 1, bb[1] - 1];
        const path = outlines.map((o) => o.map((p, i) => `${fmt2(p[0] - ox)} ${fmt2(p[1] - oy)} ${i ? "l" : "m"}`).join(" ") + " h").join(" ");
        return { content: `${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${path} f`, bbox: [ox, oy, bb[2] + 1, bb[3] + 1] };
      }, doc);
      if (!drawing) continue; // nothing drawable (shouldn't happen); the stroke stays safe in the app
      const [x1, y1, x2, y2] = drawing.bbox;
      const ap = ctx.register(ctx.stream(drawing.bytes, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, x2 - x1, y2 - y1], Matrix: [1, 0, 0, 1, x1, y1], Filter: "FlateDecode",
      }));
      annot = ctx.obj({
        Type: "Annot", Subtype: "Ink", P: page.ref, Rect: [x1, y1, x2, y2], BS: { W: w }, C: [r, g, b], F: 4,
        // The standard centerline, thinned to every few points: viewers draw the stroke from /AP anyway.
        InkList: h.ink.map((st) => { const xy: number[] = []; for (let i = 0; i + 1 < st.length; i += 9) xy.push(+fmt2(st[i]), +fmt2(st[i + 1])); const n = st.length - 3; if (n > 0 && n % 9) xy.push(+fmt2(st[n]), +fmt2(st[n + 1])); return xy; }),
        // Exact pen data (x, y, pressure) as one compact string per stroke; far cheaper than thousands of PDF numbers.
        WLPen: PDFString.of(h.ink.map((st) => st.map(fmt2).join(",")).join(";")),
        NM: PDFString.of(NM_PREFIX + h.id), T: PDFString.of(AUTHOR), M: PDFString.fromDate(now), AP: { N: ap },
      });
    } else if (h.ink?.length) {
      // Freehand marker: an /Ink annotation with a round-capped translucent stroke.
      const w = h.width ?? 12;
      const ink = h.ink;
      const drawing = cachedDrawing(`marker|${h.id}|${h.hex}|${w}`, () => {
        const bb = bounds(ink.flatMap((st) => st.filter((_, i) => i % 2 === 0)), ink.flatMap((st) => st.filter((_, i) => i % 2 === 1)));
        if (!bb) return null;
        const [ox, oy] = [bb[0] - w / 2, bb[1] - w / 2];
        const path = ink.map((st) => {
          let d = `${fmt2(st[0] - ox)} ${fmt2(st[1] - oy)} m`;
          for (let i = 2; i + 1 < st.length; i += 2) d += ` ${fmt2(st[i] - ox)} ${fmt2(st[i + 1] - oy)} l`;
          if (st.length === 2) d += ` ${fmt2(st[0] - ox + 0.01)} ${fmt2(st[1] - oy)} l`; // a dot
          return d;
        }).join(" ");
        return { content: `/GS0 gs ${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(w)} w 1 J 1 j ${path} S`, bbox: [ox, oy, bb[2] + w / 2, bb[3] + w / 2] };
      }, doc);
      if (!drawing) continue;
      const [x1, y1, x2, y2] = drawing.bbox;
      const ap = ctx.register(ctx.stream(drawing.bytes, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, x2 - x1, y2 - y1], Matrix: [1, 0, 0, 1, x1, y1], Resources: gs, Filter: "FlateDecode",
      }));
      annot = ctx.obj({
        Type: "Annot", Subtype: "Ink", P: page.ref, Rect: [x1, y1, x2, y2], InkList: h.ink, BS: { W: w },
        C: [r, g, b], F: 4, NM: PDFString.of(NM_PREFIX + h.id), T: PDFString.of(AUTHOR), M: PDFString.fromDate(now), AP: { N: ap },
      });
    } else {
      const x1 = Math.min(...h.rects.map((q) => q[0]));
      const y1 = Math.min(...h.rects.map((q) => q[1]));
      const x2 = Math.max(...h.rects.map((q) => q[2]));
      const y2 = Math.max(...h.rects.map((q) => q[3]));
      // QuadPoints in the de-facto order viewers expect: UL, UR, LL, LR.
      const quads = h.rects.flatMap(([a, c, d, e]) => [a, e, d, e, a, c, d, c]);
      const path = h.rects
        .map(([a, c, d, e]) => `${fmt(a - x1)} ${fmt(c - y1)} ${fmt(d - a)} ${fmt(e - c)} re`)
        .join(" ");
      const ap = ctx.register(ctx.stream(`/GS0 gs ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${path} f`, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, x2 - x1, y2 - y1], Matrix: [1, 0, 0, 1, x1, y1], Resources: gs,
      }));
      annot = ctx.obj({
        Type: "Annot", Subtype: "Highlight", P: page.ref, Rect: [x1, y1, x2, y2], QuadPoints: quads,
        C: [r, g, b], F: 4, NM: PDFString.of(NM_PREFIX + h.id), T: PDFString.of(AUTHOR), M: PDFString.fromDate(now), AP: { N: ap },
      });
    }
    if (h.note && h.kind !== "text") annot.set(PDFName.of("Contents"), PDFHexString.fromText(h.note));
    const ref = ctx.register(annot);
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
  }
  if (helv) await helv.embed(); // the font is written at save time; make it real before tidying up
  dropUnreachable(doc);
  return doc.save();
}

export interface ReadHighlight {
  key: string; // /NM, or a geometry key when a foreign app didn't set one
  ours: boolean;
  page: number;
  rects: Rect[];
  hex: string;
  note: string;
  ink?: number[][];
  width?: number;
  kind?: "pen" | "text";
  text?: string;
  size?: number;
}

export async function readHighlights(bytes: Uint8Array): Promise<ReadHighlight[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const out: ReadHighlight[] = [];
  const num = (o: unknown) => (o as { asNumber(): number }).asNumber();
  const text = textOf;
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    for (let j = 0; j < annots.size(); j++) {
      const d = annots.lookup(j);
      if (!(d instanceof PDFDict)) continue;
      const sub = d.get(PDFName.of("Subtype"));
      const nm = text(d.lookup(PDFName.of("NM")));
      const c = d.lookupMaybe(PDFName.of("C"), PDFArray)?.asArray().map(num);
      const hex = c?.length === 3
        ? "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")
        : "#ffeb3b";
      // Our own marker strokes come back too (e.g. after a reinstall); other apps' ink stays theirs.
      if (sub === PDFName.of("Ink") && nm.startsWith(NM_PREFIX)) {
        const penStr = text(d.lookup(PDFName.of("WLPen")));
        const penArr = d.lookupMaybe(PDFName.of("WLPoints"), PDFArray); // written by the first notes build
        const pen = penStr || penArr;
        const ink = penStr
          ? penStr.split(";").map((st) => st.split(",").map(Number))
          : ((penArr ?? d.lookupMaybe(PDFName.of("InkList"), PDFArray))?.asArray()
            .map((st) => (ctx.lookup(st) as PDFArray).asArray().map(num)) ?? []);
        const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asArray().map(num) as Rect | undefined;
        const w = (d.lookupMaybe(PDFName.of("BS"), PDFDict)?.lookup(PDFName.of("W")) as { asNumber?: () => number } | undefined)?.asNumber?.() ?? 12;
        if (ink.length && rect) out.push({ key: nm, ours: true, page: i + 1, rects: [rect], hex, note: text(d.lookup(PDFName.of("Contents"))), ink, width: w, ...(pen ? { kind: "pen" as const } : {}) });
        continue;
      }
      if (sub === PDFName.of("FreeText") && nm.startsWith(NM_PREFIX)) {
        const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asArray().map(num) as Rect | undefined;
        const size = (d.lookup(PDFName.of("WLSize")) as PDFNumber | undefined)?.asNumber?.() ?? 14;
        const color = text(d.lookup(PDFName.of("WLColor"))) || "#2b2130";
        if (rect) out.push({ key: nm, ours: true, page: i + 1, rects: [rect], hex: color, note: "", kind: "text", text: text(d.lookup(PDFName.of("Contents"))), size });
        continue;
      }
      if (sub !== PDFName.of("Highlight")) continue;
      const qp = d.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
      const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const rects = qp
        ? rectsFromQuads(qp.asArray().map(num))
        : rect ? [rect.asArray().map(num) as Rect] : [];
      if (!rects.length) continue;
      out.push({
        key: nm || `p${i + 1}:${rects.flat().map(Math.round).join(",")}`,
        ours: nm.startsWith(NM_PREFIX),
        page: i + 1,
        rects,
        hex,
        note: text(d.lookup(PDFName.of("Contents"))),
      });
    }
  });
  return out;
}

/** Text of the page items whose baseline origin falls inside any of the rects. */
export function textInRects(items: { str: string; transform: number[] }[], rects: Rect[]): string {
  return items
    .filter((it) => rects.some(([a, b, c, d]) => {
      const [x, y] = [it.transform[4], it.transform[5]];
      return x >= a - 2 && x <= c + 2 && y >= b - 4 && y <= d + 2;
    }))
    .map((it) => it.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The two pdf.js PageViewport methods we use. */
export interface Viewport {
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

/** Box in viewport pixels (x, y, w, h; y down) -> PDF-space rect. Handles rotation and crop offsets. */
export function toPdfRect(vp: Viewport, x: number, y: number, w: number, h: number): Rect {
  const [a, b] = vp.convertToPdfPoint(x, y);
  const [c, d] = vp.convertToPdfPoint(x + w, y + h);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** PDF-space rect -> viewport pixels {left, top, width, height}. */
export function toViewBox(vp: Viewport, [a, b, c, d]: Rect) {
  const [x1, y1] = vp.convertToViewportPoint(a, b);
  const [x2, y2] = vp.convertToViewportPoint(c, d);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
