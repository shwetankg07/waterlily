import { q, getSetting, today, type FileRow, type FolderRow } from "./db";
import { displayName, baseName, dirs } from "./lib";
import { useData, useVersion, loadDays, streakOf, dayCounts, daysUntil } from "./ui";
import { Plant, StreakGraph } from "./Garden";
import type { Go } from "./App";

const greeting = (h = new Date().getHours()) =>
  h < 5 ? "up late" : h < 12 ? "good morning" : h < 17 ? "good afternoon" : "good evening";

export default function Home({ go }: { go: Go }) {
  const v = useVersion();
  const d = useData(async () => {
    const [name, recent, exams, days] = await Promise.all([
      getSetting("nickname"),
      q<FileRow>(`SELECT id, rel, thumb, cover, pages, max_page, last_page FROM files WHERE missing=0 AND opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT 5`),
      q<FolderRow>(`SELECT * FROM folders WHERE exam_date >= $1 ORDER BY exam_date LIMIT 5`, [today()]),
      loadDays(),
    ]);
    const [t] = await q<{ s: number; h: number }>(`SELECT coalesce(sum(seconds),0) s, coalesce(sum(highlights),0) h FROM activity WHERE day=$1`, [today()]);
    return { name, recent, exams, days, t };
  }, [v]);
  if (!d) return null;
  const streak = streakOf(d.days);

  return (
    <div className="page-wrap">
      <header className="hello">
        <h1 className="hand"><span className="swipe">{greeting()}{d.name ? `, ${d.name}` : ""}</span> ✿</h1>
        <p className="muted">
          {d.t.s < 60 && !d.t.h ? "Nothing studied yet today." : `Today so far: ${Math.round(d.t.s / 60)} min reading, ${d.t.h} highlight${d.t.h === 1 ? "" : "s"}.`}
        </p>
      </header>

      <div className="tiles">
        <section className="tile">
          <h3>Continue reading</h3>
          {d.recent.length ? d.recent.map((f) => (
            <button key={f.id} className="recent" onClick={() => go({ name: "reader", fileId: f.id })}>
              <img src={f.cover ?? f.thumb ?? undefined} alt="" />
              <span className="grow">
                <b>{displayName(f.rel)}</b>
                <div className="muted" style={{ fontSize: ".85rem" }}>page {f.last_page}{f.pages ? ` of ${f.pages}` : ""}</div>
                {f.pages > 0 && <div className="progress"><i style={{ width: `${Math.min(100, (f.max_page / f.pages) * 100)}%` }} /></div>}
              </span>
            </button>
          )) : <p className="muted">PDFs you open will show up here. <button className="btn small" onClick={() => go({ name: "library", folder: "" })}>Open the library</button></p>}
        </section>

        <section className="tile">
          <h3>Exams coming up</h3>
          {/* Folders deleted or renamed outside the app keep their row; don't count down to them. */}
          {d.exams.some((e) => dirs.includes(e.rel)) ? d.exams.filter((e) => dirs.includes(e.rel)).map((e) => {
            const n = daysUntil(e.exam_date!);
            return (
              <div key={e.rel} className="countdown">
                <span>{e.stickers} {e.exam_label || "exam"}: {baseName(e.rel)}</span>
                <b>{n === 0 ? "today!" : n === 1 ? "tomorrow" : `${n} days`}</b>
              </div>
            );
          }) : <p className="muted">Set an exam date on a folder (the ⋯ button in the Library) to count down to it here.</p>}
        </section>

        <section className="tile row" style={{ flexWrap: "nowrap", cursor: "pointer" }} onClick={() => go({ name: "garden" })}>
          <Plant streak={streak} wilting={streak > 0 && !dayCounts(d.days.get(today()))} size={110} />
          <div>
            <h3>{streak ? `${streak} day streak` : "no streak yet"}</h3>
            <p className="muted">{dayCounts(d.days.get(today())) ? "Watered today ✓" : "Read 5 minutes or highlight something to water it."}</p>
          </div>
        </section>
      </div>
      <StreakGraph days={d.days} />
    </div>
  );
}
