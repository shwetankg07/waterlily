// Pure PDF helpers (no DOM, no Tauri) so they can be checked from node: scripts/check.mjs
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRef } from "pdf-lib";

/** A rectangle in PDF user space: [x1, y1, x2, y2] with x1<x2, y1<y2. */
export type Rect = [number, number, number, number];

export interface WritableHighlight {
  id: string;
  page: number; // 1-based
  rects: Rect[];
  hex: string;
  note: string;
}

/** Annotations we write carry this prefix in /NM so we recognise our own on re-read. */
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

/**
 * Replace every /Highlight annotation in the PDF with the given highlights.
 * Foreign highlights must already have been imported (see readHighlights),
 * so dropping them loses nothing. Popups that belonged to dropped highlights go too.
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
      if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Highlight")) {
        dropped.add(String(o));
      }
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
  for (const h of hs) {
    const page = pages[h.page - 1];
    if (!page || !h.rects.length) continue;
    const [r, g, b] = hexToRgb(h.hex);
    const x1 = Math.min(...h.rects.map((q) => q[0]));
    const y1 = Math.min(...h.rects.map((q) => q[1]));
    const x2 = Math.max(...h.rects.map((q) => q[2]));
    const y2 = Math.max(...h.rects.map((q) => q[3]));
    // QuadPoints in the de-facto order viewers expect: UL, UR, LL, LR.
    const quads = h.rects.flatMap(([a, c, d, e]) => [a, e, d, e, a, c, d, c]);
    const path = h.rects
      .map(([a, c, d, e]) => `${fmt(a - x1)} ${fmt(c - y1)} ${fmt(d - a)} ${fmt(e - c)} re`)
      .join(" ");
    const ap = ctx.register(
      ctx.stream(`/GS0 gs ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${path} f`, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, x2 - x1, y2 - y1],
        Matrix: [1, 0, 0, 1, x1, y1],
        Resources: { ExtGState: { GS0: { Type: "ExtGState", BM: "Multiply" } } },
      }),
    );
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Highlight",
      P: page.ref,
      Rect: [x1, y1, x2, y2],
      QuadPoints: quads,
      C: [r, g, b],
      F: 4,
      NM: PDFString.of(NM_PREFIX + h.id),
      M: PDFString.fromDate(now),
      AP: { N: ap },
    });
    if (h.note) annot.set(PDFName.of("Contents"), PDFHexString.fromText(h.note));
    const ref = ctx.register(annot);
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
  }
  return doc.save();
}

export interface ReadHighlight {
  key: string; // /NM, or a geometry key when a foreign app didn't set one
  ours: boolean;
  page: number;
  rects: Rect[];
  hex: string;
  note: string;
}

export async function readHighlights(bytes: Uint8Array): Promise<ReadHighlight[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: ReadHighlight[] = [];
  const num = (o: unknown) => (o as { asNumber(): number }).asNumber();
  const text = (o: unknown) =>
    o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "";
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    for (let j = 0; j < annots.size(); j++) {
      const d = annots.lookup(j);
      if (!(d instanceof PDFDict) || d.get(PDFName.of("Subtype")) !== PDFName.of("Highlight")) continue;
      const qp = d.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
      const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const rects = qp
        ? rectsFromQuads(qp.asArray().map(num))
        : rect ? [rect.asArray().map(num) as Rect] : [];
      if (!rects.length) continue;
      const c = d.lookupMaybe(PDFName.of("C"), PDFArray)?.asArray().map(num);
      const hex = c?.length === 3
        ? "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")
        : "#ffeb3b";
      const nm = text(d.lookup(PDFName.of("NM")));
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
