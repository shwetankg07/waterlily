import { useState } from "react";
import { q, run } from "./db";
import { useData } from "./ui";
import { sound, sparkle } from "./fx";

interface Todo { id: number; text: string; done_at: number | null; created_at: number }

/** A plain to-do list: add, tick off, edit in place, delete. */
export default function TodoList() {
  const [v, setV] = useState(0);
  const refresh = () => setV((x) => x + 1);
  const todos = useData(() => q<Todo>(`SELECT * FROM todos ORDER BY created_at`), [v]);
  const [draft, setDraft] = useState("");
  if (!todos) return null;
  const open = todos.filter((t) => !t.done_at);
  const done = todos.filter((t) => t.done_at).sort((a, b) => b.done_at! - a.done_at!);

  async function add() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await run(`INSERT INTO todos(text, created_at) VALUES ($1, $2)`, [text, Date.now()]);
    refresh();
  }
  async function toggle(t: Todo, e: React.MouseEvent) {
    await run(`UPDATE todos SET done_at=$2 WHERE id=$1`, [t.id, t.done_at ? null : Date.now()]);
    if (!t.done_at) { sound.pop(); sparkle(e.clientX, e.clientY); }
    refresh();
  }
  async function rename(t: Todo, text: string) {
    text = text.trim();
    if (text === t.text) return;
    // Clearing the text removes the to-do.
    await (text ? run(`UPDATE todos SET text=$2 WHERE id=$1`, [t.id, text]) : run(`DELETE FROM todos WHERE id=$1`, [t.id]));
    refresh();
  }
  const remove = async (t: Todo) => { await run(`DELETE FROM todos WHERE id=$1`, [t.id]); refresh(); };
  const clearDone = async () => { await run(`DELETE FROM todos WHERE done_at IS NOT NULL`); refresh(); };

  const item = (t: Todo) => (
    <li key={t.id} className={`todo ${t.done_at ? "done" : ""}`}>
      <button className="tick" aria-pressed={!!t.done_at} aria-label={t.done_at ? `Mark "${t.text}" not done` : `Mark "${t.text}" done`}
        onClick={(e) => void toggle(t, e)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5 9-10" /></svg>
      </button>
      <input className="todo-text" defaultValue={t.text} aria-label="To-do" maxLength={300}
        onBlur={(e) => void rename(t, e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
      <button className="todo-del" aria-label={`Delete "${t.text}"`} title="Delete" onClick={() => void remove(t)}>×</button>
    </li>
  );

  return (
    <div className="page-wrap todo-page">
      <h1 className="hand">To-do</h1>
      <p className="muted">{open.length ? `${open.length} thing${open.length === 1 ? "" : "s"} to do` : done.length ? "All done! ✿" : "Nothing here yet."}</p>
      <form className="row todo-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="field grow" placeholder="Add a to-do, then press Enter" value={draft} maxLength={300}
          onChange={(e) => setDraft(e.target.value)} aria-label="New to-do" />
        <button className="btn primary" disabled={!draft.trim()}>Add</button>
      </form>
      <ul className="todos">{open.map(item)}</ul>
      {done.length > 0 && (
        <>
          <div className="row todo-done-head">
            <h2 className="hand">Done ({done.length})</h2>
            <span className="grow" />
            <button className="btn small ghost" onClick={() => void clearDone()}>Clear done</button>
          </div>
          <ul className="todos">{done.map(item)}</ul>
        </>
      )}
    </div>
  );
}
