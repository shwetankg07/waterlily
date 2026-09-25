import { q, today } from "./db";
import { useData, useVersion, loadDays, streakOf, bestStreak, dayCounts, type Day } from "./ui";

/** Growth stage from streak length. */
const stageOf = (s: number) => (s >= 30 ? 5 : s >= 14 ? 4 : s >= 7 ? 3 : s >= 3 ? 2 : s >= 1 ? 1 : 0);
const STAGE_NAMES = ["a seed, waiting", "a tiny sprout", "growing leaves", "a bud!", "in bloom", "a whole bouquet"];

export function Plant({ streak, wilting, size = 220 }: { streak: number; wilting?: boolean; size?: number }) {
  const st = stageOf(streak);
  const leaf = "#f7a9c7", leafDark = "#e47ea6"; // a pink plant
  const flower = (x: number, y: number, r: number, key: number) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx="0" cy={-r} rx={r * 0.62} ry={r} fill="var(--accent)" opacity=".9" transform={`rotate(${a})`} />)}
      <circle r={r * 0.55} fill="#ffe3ef" />
    </g>
  );
  return (
    <svg className={`plant ${wilting ? "wilt" : ""}`} viewBox="0 0 220 240" width={size} height={size * 240 / 220} role="img"
      aria-label={`Your plant is ${STAGE_NAMES[st]}`}>
      <g className="sway">
        <g className="stem">
          {st >= 1 && <path d={`M110 188 C ${st >= 2 ? "104 150 116 120 110 " + (st >= 3 ? 70 : 118) : "108 176 112 168 110 160"}`} stroke={leafDark} strokeWidth="5" fill="none" strokeLinecap="round" />}
          {st >= 1 && <><ellipse cx="96" cy="166" rx="15" ry="7" fill={leaf} transform="rotate(-28 96 166)" /><ellipse cx="124" cy="164" rx="15" ry="7" fill={leaf} transform="rotate(28 124 164)" /></>}
          {st >= 2 && <><ellipse cx="94" cy="134" rx="18" ry="8" fill={leaf} transform="rotate(-24 94 134)" /><ellipse cx="127" cy="128" rx="18" ry="8" fill={leaf} transform="rotate(24 127 128)" /></>}
          {st === 3 && <ellipse cx="110" cy="62" rx="11" ry="16" fill="var(--accent)" />}
          {st >= 4 && flower(110, 62, 17, 0)}
          {st >= 5 && <>
            <path d="M110 120 C 90 100 80 96 72 88" stroke={leafDark} strokeWidth="4" fill="none" />
            <path d="M110 110 C 130 96 140 92 150 84" stroke={leafDark} strokeWidth="4" fill="none" />
            {flower(70, 84, 12, 1)}{flower(152, 80, 12, 2)}
          </>}
        </g>
      </g>
      {st === 0 && <ellipse cx="110" cy="186" rx="7" ry="5" fill="#b08968" />}
      <path d="M62 188 H158 L148 234 H72 Z" fill="var(--accent)" />
      <rect x="56" y="180" width="108" height="16" rx="5" fill="color-mix(in srgb, var(--accent) 80%, #000 12%)" />
      <ellipse cx="110" cy="182" rx="48" ry="4" fill="#7a5a44" opacity=".5" />
    </svg>
  );
}

export default function Garden() {
  const v = useVersion();
  const data = useData(async () => {
    const days = await loadDays();
    const [tot] = await q<{ h: number; s: number; f: number }>(
      `SELECT (SELECT count(*) FROM highlights WHERE coalesce(kind, '') NOT IN ('pen', 'text')) h, coalesce(sum(seconds),0) s, coalesce(sum(focus_min),0) f FROM activity`,
    );
    return { days, tot };
  }, [v]);
  if (!data) return null;
  const { days, tot } = data;
  const streak = streakOf(days);
  const doneToday = dayCounts(days.get(today()));

  return (
    <div className="page-wrap">
      <div className="garden-top">
        <Plant streak={streak} wilting={streak > 0 && !doneToday} />
        <div>
          <h1 className="hand">{streak ? `${streak} day streak` : "plant a seed today"}</h1>
          <p className="muted" style={{ maxWidth: "52ch" }}>
            {doneToday
              ? "Today's watered. Come back tomorrow to keep it growing."
              : streak
                ? "Your plant is thirsty. Read for 5 minutes, highlight something, or finish a focus session to water it."
                : "Any day you read for 5 minutes, make a highlight, or finish a focus session counts toward your streak."}
          </p>
          <div className="stats" style={{ marginTop: "1.2rem" }}>
            <div className="stat"><b>{bestStreak(days)}</b><span className="muted">best streak</span></div>
            <div className="stat"><b>{tot.h}</b><span className="muted">highlights</span></div>
            <div className="stat"><b>{(tot.s / 3600).toFixed(1)}</b><span className="muted">hours reading</span></div>
            <div className="stat"><b>{Math.round(tot.f / 25)}</b><span className="muted">focus sessions</span></div>
          </div>
        </div>
      </div>
      <StreakGraph days={days} />
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const score = (d?: Day) => (d ? d.seconds / 60 + d.highlights * 3 + d.focus : 0);
const level = (s: number) => (s <= 0 ? 0 : s < 10 ? 1 : s < 30 ? 2 : s < 60 ? 3 : 4);

/** GitHub-style year graph; the busiest days bloom into little flowers. */
export function StreakGraph({ days }: { days: Map<string, Day> }) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 52 * 7 - now.getDay());
  const weeks: Date[][] = [];
  for (let w = 0; w < 53; w++) {
    weeks.push(Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + w * 7 + i); return d; }));
  }
  const active = [...days.values()].filter((d) => d.day >= today(start) && dayCounts(d)).length;
  const t = today();
  return (
    <div className="graph-card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: ".8rem" }}>
        <h2 className="hand">{active} study day{active === 1 ? "" : "s"} this year</h2>
      </div>
      <div className="graph" role="img" aria-label={`${active} study days in the last year`}>
        <span />
        {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => <span key={"wd" + i} className="wd">{d}</span>)}
        {weeks.map((wk, w) => {
          const first = wk.find((d) => d.getDate() === 1);
          return [
            <span key={"m" + w} className="m">{first && w < 52 ? MONTHS[first.getMonth()] : ""}</span>,
            ...wk.map((d) => {
              const k = today(d);
              const day = days.get(k);
              const future = k > t;
              const mins = Math.round((day?.seconds ?? 0) / 60);
              const tip = future ? "" : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ` +
                (day ? `${mins} min reading, ${day.highlights} highlight${day.highlights === 1 ? "" : "s"}${day.focus ? `, ${day.focus} min focus` : ""}` : "no study");
              return <span key={k} title={tip} className={`cell l${future ? 0 : level(score(day))} ${k === t ? "today" : ""} ${future ? "future" : ""}`} />;
            }),
          ];
        })}
      </div>
      <div className="legend">less <span className="cell" /> <span className="cell l1" /> <span className="cell l2" /> <span className="cell l3" /> <span className="cell l4" /> more</div>
    </div>
  );
}
