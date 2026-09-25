import { useEffect, useRef, useState, type ReactNode } from "react";
import { changes } from "./lib";
import { q, today } from "./db";
import { toast } from "./fx";

/** Re-render whenever library data changes. Use the returned number as an effect dependency. */
export function useVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const f = () => setV((x) => x + 1);
    changes.addEventListener("change", f);
    return () => changes.removeEventListener("change", f);
  }, []);
  return v;
}

/** Load async data, re-running when deps change. */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): T | undefined {
  const [d, setD] = useState<T>();
  useEffect(() => {
    let live = true;
    load().then((x) => live && setD(x), (e) => { console.error(e); if (live) toast(`Something went wrong loading this: ${e}`); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return d;
}

/**
 * Two-finger pinch on a touchscreen zooms by calling zoom(k). The browser's own pinch is off
 * (touch-action on .pages), so the whole app never zooms. `ignore` skips it, e.g. while a stylus is writing.
 */
export function usePinch(ref: React.RefObject<HTMLElement | null>, zoom: React.RefObject<(k: number) => void>, ignore: () => boolean, deps: unknown[]) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let base = 0;
    const on = (e: TouchEvent) => {
      if (e.touches.length !== 2 || ignore()) { base = 0; return; }
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!base) base = d;
      else if (d / base > 1.12 || d / base < 1 / 1.12) { zoom.current(d / base); base = d; }
    };
    const kinds = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const k of kinds) el.addEventListener(k, on, { passive: true });
    return () => { for (const k of kinds) el.removeEventListener(k, on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Native <dialog>, opened while mounted. Closes on Esc, or a click that starts and ends on the backdrop. */
export function Dialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOutside = useRef(false);
  useEffect(() => { ref.current?.showModal(); }, []);
  // Clicks in the dialog's own padding also target the <dialog>, so test the position instead.
  const outside = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return e.target === ref.current && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  return (
    <dialog ref={ref} onClose={onClose}
      onMouseDown={(e) => (downOutside.current = outside(e))}
      onClick={(e) => { if (downOutside.current && outside(e)) onClose(); }}>
      {children}
    </dialog>
  );
}

// Notebook and tag colors: ten pinks, from blush to raspberry.
export const PASTELS = [
  "#ffe4ef", "#ffd3e5", "#ffc4dc", "#ffb3d1", "#ff9fc6",
  "#fbc6d8", "#f8b4c9", "#f6c1cf", "#ffcfe0", "#f4a7c4",
];

export const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].map((x) => x.segment).filter((x) => x.trim());

// Emoji 12 or older only: newer ones (bubble tea, lotus, bubbles) show as empty boxes on Windows 10.
export const STICKERS = graphemes("🌸🌷🌼🌻🌹🌺💐🍀🌿🍄🍓🍒🍑🍋🧁🍰🍩🍪🍦🍵🎀💖💗💞💕💌⭐🌟✨🌙☁️🌈🦋🐝🐞🐰🐱🐻🐼🦊🐥🐣🦄🐶🐹🐸🐧📚📖📝✏️🖍️📌📎🔬🧪🧬🧮💡🎓🏆🎧🎨🧸💎👑🕯️🍂🌊🎹🩰🐚");

export function StickerPicker({ value, onChange, max = 3 }: { value: string; onChange: (v: string) => void; max?: number }) {
  const picked = graphemes(value);
  const toggle = (s: string) => {
    const next = picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s].slice(-max);
    onChange(next.join(""));
  };
  return (
    <div className="emoji-grid">
      {STICKERS.map((s) => (
        <button key={s} type="button" aria-pressed={picked.includes(s)} onClick={() => toggle(s)} aria-label={`sticker ${s}`}>
          {s}
        </button>
      ))}
    </div>
  );
}

/** Resize a picked image to a small JPEG data URL so it can live in the database (and backups). */
export function imageToDataUrl(file: File, max = 640): Promise<string> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      if (!img.width || !img.height) return img.onerror?.(new Event("error"));
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = img.width * k;
      c.height = img.height * k;
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); rej(new Error("that picture's format can't be opened. Try a JPG or PNG")); };
    img.src = URL.createObjectURL(file);
  });
}

// ---------- streaks ----------

export interface Day { day: string; seconds: number; highlights: number; focus: number }

export const dayCounts = (d?: Day) => !!d && (d.seconds >= 300 || d.highlights > 0 || d.focus > 0);

export async function loadDays(): Promise<Map<string, Day>> {
  const rows = await q<Day>(
    `SELECT day, sum(seconds) seconds, sum(highlights) highlights, sum(focus_min) focus FROM activity GROUP BY day`,
  );
  return new Map(rows.map((r) => [r.day, r]));
}

const shift = (n: number, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + n); return d; };

/** Current streak: consecutive counted days ending today (or yesterday, if today isn't done yet). */
export function streakOf(days: Map<string, Day>) {
  let i = dayCounts(days.get(today())) ? 0 : -1;
  let n = 0;
  while (dayCounts(days.get(today(shift(i))))) { n++; i--; }
  return n;
}

export function bestStreak(days: Map<string, Day>) {
  const sorted = [...days.values()].filter(dayCounts).map((d) => d.day).sort();
  let best = 0, run = 0, prev = "";
  for (const d of sorted) {
    run = prev && today(shift(1, new Date(prev + "T12:00"))) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export const daysUntil = (iso: string) =>
  Math.round((new Date(iso + "T00:00").getTime() - new Date(today() + "T00:00").getTime()) / 86400000);
