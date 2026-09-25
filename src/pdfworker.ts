// Rewriting a PDF can take a second for a big note or textbook. It runs here, off the page's thread,
// so writing with the pen and scrolling never stutter while a save is going on. See offThread in lib.ts.
import { writeHighlights, readHighlights, addPaperPage } from "./pdfcore";

const jobs: Record<string, (...a: never[]) => Promise<unknown>> = { writeHighlights, readHighlights, addPaperPage };

self.onmessage = async ({ data: { id, fn, args } }: MessageEvent<{ id: number; fn: string; args: never[] }>) => {
  try {
    const result = await jobs[fn](...args);
    self.postMessage({ id, result }, { transfer: result instanceof Uint8Array ? [result.buffer] : [] });
  } catch (e) {
    self.postMessage({ id, error: { name: (e as Error)?.name ?? "Error", message: String((e as Error)?.message ?? e) } });
  }
};
