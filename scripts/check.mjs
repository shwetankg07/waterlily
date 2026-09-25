// Run: npm run check. Round-trips highlights through a real PDF and viewport geometry.
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { writeHighlights, readHighlights, toPdfRect, toViewBox, mergeLineRects, NM_PREFIX, paperPdf, addPaperPage } from "../src/pdfcore.ts";

// A 2-page PDF with a CropBox offset and one "foreign" highlight + its popup on page 1.
const src = await PDFDocument.create();
const p1 = src.addPage([600, 800]);
p1.setCropBox(50, 50, 500, 700);
src.addPage([600, 800]);
const ctx = src.context;
const foreign = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [100, 100, 200, 120], QuadPoints: [100, 120, 200, 120, 100, 100, 200, 100], C: [1, 1, 0], Contents: PDFString.of("from edge") }));
const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [0, 0, 10, 10], Parent: foreign }));
const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10] }));
p1.node.set(PDFName.of("Annots"), ctx.obj([foreign, popup, link]));
const bytes = await src.save();

// Foreign highlight is read with its note and marked not-ours.
const before = await readHighlights(bytes);
assert.equal(before.length, 1);
assert.equal(before[0].ours, false);
assert.equal(before[0].note, "from edge");
assert.deepEqual(before[0].rects, [[100, 100, 200, 120]]);

// Write ours: foreign highlight + its popup are replaced, the link survives.
const out = await writeHighlights(bytes, [
  { id: "a1", page: 1, rects: [[100, 100, 200, 120], [100, 80, 150, 98]], hex: "#ffb3d1", note: "defn ✿" },
  { id: "b2", page: 2, rects: [[10, 10, 20, 20]], hex: "#b5e8c8", note: "" },
]);
const after = await readHighlights(out);
assert.equal(after.length, 2);
assert.ok(after.every((h) => h.ours));
assert.equal(after[0].key, NM_PREFIX + "a1");
assert.equal(after[0].note, "defn ✿");
assert.equal(after[0].hex, "#ffb3d1");
assert.deepEqual(after[0].rects, [[100, 100, 200, 120], [100, 80, 150, 98]]);
const again = await PDFDocument.load(out);
const subtypes = again.getPage(0).node.Annots().asArray().map((r) => again.context.lookup(r).get(PDFName.of("Subtype")).toString());
assert.deepEqual(subtypes.sort(), ["/Highlight", "/Link"]);
// Writing twice is idempotent (no duplicate annotations).
assert.equal((await readHighlights(await writeHighlights(out, [{ id: "a1", page: 1, rects: [[1, 1, 2, 2]], hex: "#000000", note: "" }]))).length, 1);

// pdf.js itself sees our annotations (i.e. other viewers will too).
const pdf = await pdfjs.getDocument({ data: out.slice() }).promise;
const annots = await (await pdf.getPage(1)).getAnnotations();
const hl = annots.find((a) => a.subtype === "Highlight");
assert.ok(hl, "pdf.js sees the highlight");
assert.equal(hl.contentsObj.str, "defn ✿");

// Viewport round trip at several zooms and rotations, on the cropped page.
const page = await pdf.getPage(1);
for (const scale of [0.5, 1, 1.75, 3]) {
  for (const rotation of [0, 90, 180, 270]) {
    const vp = page.getViewport({ scale, rotation });
    const r = [120, 300, 260, 318];
    const b = toViewBox(vp, r);
    const back = toPdfRect(vp, b.left, b.top, b.width, b.height);
    back.forEach((v, i) => assert.ok(Math.abs(v - r[i]) < 1e-6, `scale ${scale} rot ${rotation}: ${back} vs ${r}`));
  }
}

// Span rects on one line merge; separate lines don't.
assert.deepEqual(mergeLineRects([[10, 100, 50, 112], [52, 100, 90, 112], [10, 80, 40, 92]]), [[10, 100, 90, 112], [10, 80, 40, 92]]);

// Marker strokes: written as our own /Ink, read back with their points, idempotent,
// and another app's ink drawing on the same page is left alone.
{
  const d = await PDFDocument.load(out);
  const c = d.context, pg = d.getPage(0);
  const theirs = c.register(c.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 50, 50], InkList: [[1, 1, 40, 40]], C: [0, 0, 1] }));
  pg.node.Annots().push(theirs);
  const withInk = await d.save();
  const ink = [[100, 300, 140, 310, 180, 305], [120, 280, 160, 285]];
  const once = await writeHighlights(withInk, [
    { id: "a1", page: 1, rects: [[100, 100, 200, 120]], hex: "#ffb3cf", note: "" },
    { id: "m1", page: 1, rects: [[94, 274, 186, 316]], hex: "#a8d8ff", note: "a diagram", ink, width: 12 },
  ]);
  const twice = await writeHighlights(once, [{ id: "m1", page: 1, rects: [[94, 274, 186, 316]], hex: "#a8d8ff", note: "a diagram", ink, width: 12 }]);
  for (const bytes of [once, twice]) {
    const back = await readHighlights(bytes);
    const m = back.find((h) => h.key === NM_PREFIX + "m1");
    assert.ok(m && m.ours, "our marker stroke is read back");
    assert.deepEqual(m.ink, ink);
    assert.equal(m.width, 12);
    assert.equal(m.note, "a diagram");
    const doc = await PDFDocument.load(bytes);
    const kinds = doc.getPage(0).node.Annots().asArray().map((r) => doc.context.lookup(r).get(PDFName.of("Subtype")).toString());
    assert.equal(kinds.filter((k) => k === "/Ink").length, 2, "one marker of ours, one ink drawing of theirs");
  }
  const pj = await pdfjs.getDocument({ data: twice.slice() }).promise;
  const a = (await (await pj.getPage(1)).getAnnotations()).find((x) => x.subtype === "Ink" && x.titleObj?.str === "Waterlily");
  assert.ok(a, "pdf.js sees our stroke and its author tag (used to avoid drawing it twice)");
}

// Notes: paper pages, and handwriting that comes back with its exact points and pressure.
{
  const note = await addPaperPage(await paperPdf("lined"), "grid");
  assert.equal((await PDFDocument.load(note)).getPageCount(), 2, "a new note gets another page");
  const stroke = [100, 700, 0.3, 120, 705, 0.6, 140, 702, 0.9, 160, 698, 0.5];
  const written = await writeHighlights(note, [{ id: "p1", page: 2, rects: [[98, 694, 162, 709]], hex: "#2b2130", note: "", ink: [stroke], width: 2.5, kind: "pen" }]);
  const back = (await readHighlights(written)).find((h) => h.key === NM_PREFIX + "p1");
  assert.ok(back && back.kind === "pen" && back.page === 2, "handwriting is read back as pen ink on its page");
  assert.deepEqual(back.ink, [stroke]);
  const pj = await pdfjs.getDocument({ data: written.slice() }).promise;
  const a = (await (await pj.getPage(2)).getAnnotations()).find((x) => x.subtype === "Ink");
  assert.ok(a && a.hasAppearance !== false, "other viewers get the drawn stroke");
  // A note says it's a note (and its paper) inside the file, through saves, so a reinstall still knows.
  const info = (await pj.getMetadata()).info;
  assert.match(String(info.Keywords), /\bwaterlily-paper:lined\b/, "the note's paper is kept in the file");
  // A long stroke (a minute of scribbling) round-trips, and later saves reuse its drawing.
  const long = Array.from({ length: 6000 }, (_, i) => [100 + (i % 400), 300 + Math.sin(i / 9) * 40, 0.5]).flat();
  const w2 = await writeHighlights(note, [{ id: "p2", page: 1, rects: [[90, 250, 510, 350]], hex: "#2b2130", note: "", ink: [long], width: 2.5, kind: "pen" }]);
  assert.equal((await readHighlights(w2)).find((h) => h.key === NM_PREFIX + "p2")?.ink[0].length, long.length, "a long stroke comes back whole");
}

// Typed boxes come back with their words, size and color; saving again and again doesn't grow the file.
{
  const box = { id: "t1", page: 1, rects: [[60, 600, 300, 640]], hex: "#b8325e", note: "", kind: "text", text: "Entropy ↑ always\nनोट", size: 16 };
  let bytes = await writeHighlights(await paperPdf("blank"), [box]);
  const t = (await readHighlights(bytes)).find((h) => h.key === NM_PREFIX + "t1");
  assert.ok(t && t.kind === "text" && t.text === box.text && t.size === 16 && t.hex === "#b8325e", "typed box read back exactly");
  const first = bytes.length;
  for (let i = 0; i < 5; i++) bytes = await writeHighlights(bytes, [box]);
  assert.ok(bytes.length < first * 1.05, `repeated saves don't grow the file (${first} → ${bytes.length})`);
}

console.log("✓ all checks passed");
