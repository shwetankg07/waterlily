// Toasts, little synthesized sounds (no audio files to ship), and sparkles.

export const prefs = { sounds: true, motion: true };
const calm = () => !prefs.motion || matchMedia("(prefers-reduced-motion: reduce)").matches;

export function toast(msg: string) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = Object.assign(document.createElement("div"), { id: "toasts" });
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}

let ac: AudioContext | null = null;
function tone(freq: number, at: number, dur: number, type: OscillatorType = "sine", vol = 0.12) {
  ac ??= new AudioContext();
  if (ac.state === "suspended") void ac.resume(); // created outside a click: browsers start it paused
  const o = ac.createOscillator();
  const g = ac.createGain();
  const t = ac.currentTime + at;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sound = {
  pop() { if (prefs.sounds) { tone(660, 0, 0.12); tone(990, 0.04, 0.1, "sine", 0.06); } },
  tick() { if (prefs.sounds) tone(1200, 0, 0.04, "triangle", 0.04); },
  whoosh() { if (prefs.sounds) { tone(420, 0, 0.18, "triangle", 0.05); tone(560, 0.06, 0.16, "triangle", 0.04); } },
  chime() { if (prefs.sounds) [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.12, 0.6, "sine", 0.08)); },
};

const GLYPHS = ["✦", "✿", "♡", "✧", "❀"];
export function sparkle(x: number, y: number, color = "var(--accent)", n = 7) {
  if (calm()) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    s.className = "sparkle";
    s.textContent = GLYPHS[i % GLYPHS.length];
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const d = 26 + Math.random() * 26;
    s.style.cssText = `left:${x}px;top:${y}px;color:${color};--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px`;
    document.body.append(s);
    setTimeout(() => s.remove(), 800);
  }
}

/** Bigger celebration (focus session done, streak milestone). */
export function confetti() {
  if (calm()) return;
  const w = innerWidth;
  for (let i = 0; i < 14; i++) setTimeout(() => sparkle(Math.random() * w, innerHeight * (0.2 + Math.random() * 0.4), undefined, 6), i * 70);
}
