import Database from "@tauri-apps/plugin-sql";
import type { Rect } from "./pdfcore";

let db: Database;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS files(
    id INTEGER PRIMARY KEY, rel TEXT UNIQUE, size INT, mtime INT, hash TEXT,
    pages INT DEFAULT 0, last_page INT DEFAULT 1, max_page INT DEFAULT 0,
    thumb TEXT, color TEXT, stickers TEXT DEFAULT '', cover TEXT,
    indexed_mtime INT, missing INT DEFAULT 0, added_at INT, opened_at INT)`,
  `CREATE TABLE IF NOT EXISTS folders(
    rel TEXT PRIMARY KEY, color TEXT, stickers TEXT DEFAULT '', cover TEXT,
    exam_date TEXT, exam_label TEXT)`,
  `CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT)`,
  `CREATE TABLE IF NOT EXISTS file_tags(file_id INT, tag_id INT, PRIMARY KEY(file_id, tag_id))`,
  `CREATE TABLE IF NOT EXISTS colors(id INTEGER PRIMARY KEY, name TEXT, hex TEXT)`,
  `CREATE TABLE IF NOT EXISTS highlights(
    id TEXT PRIMARY KEY, file_id INT, page INT, rects TEXT, color_id INT,
    text TEXT, note TEXT DEFAULT '', created_at INT, source_key TEXT)`,
  `CREATE INDEX IF NOT EXISTS hl_file ON highlights(file_id, page)`,
  `CREATE TABLE IF NOT EXISTS activity(
    day TEXT, file_id INT, seconds INT DEFAULT 0, highlights INT DEFAULT 0, focus_min INT DEFAULT 0,
    PRIMARY KEY(day, file_id))`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS page_text USING fts5(
    text, file_id UNINDEXED, page UNINDEXED, tokenize='unicode61 remove_diacritics 2')`,
];

const DEFAULT_COLORS: [string, string][] = [
  ["definition", "#ffb3cf"],
  ["important", "#ffe680"],
  ["formula", "#a8d8ff"],
  ["example", "#b5ecc4"],
  ["doubt", "#d7c2ff"],
];

/** Schema changes after v1, applied in order and tracked with PRAGMA user_version. Only ever append. */
const MIGRATIONS = [
  // Set when a file's highlights changed and aren't written into the PDF yet; cleared after a
  // successful write. Lets a save interrupted by a crash, reload or power cut finish next launch.
  `ALTER TABLE files ADD COLUMN dirty INT DEFAULT 0`,
];

export async function openDb() {
  db = await Database.load("sqlite:waterlily.db");
  for (const s of SCHEMA) await db.execute(s);
  const [{ user_version: version }] = await q<{ user_version: number }>(`PRAGMA user_version`);
  for (let i = version; i < MIGRATIONS.length; i++) {
    await run(MIGRATIONS[i]);
    await run(`PRAGMA user_version = ${i + 1}`);
  }
  const [{ n }] = await q<{ n: number }>(`SELECT count(*) n FROM colors`);
  if (!n) for (const [name, hex] of DEFAULT_COLORS) await run(`INSERT INTO colors(name, hex) VALUES ($1, $2)`, [name, hex]);
}

export const closeDb = () => db.close();
export const q = <T,>(sql: string, args: unknown[] = []) => db.select<T[]>(sql, args);
export const run = (sql: string, args: unknown[] = []) => db.execute(sql, args);

export async function getSetting(k: string): Promise<string | null> {
  const r = await q<{ v: string }>(`SELECT v FROM settings WHERE k=$1`, [k]);
  return r[0]?.v ?? null;
}
export const setSetting = (k: string, v: string) =>
  run(`INSERT INTO settings(k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, v]);

/** Local calendar day, YYYY-MM-DD (built by hand: locale date formats differ between engines). */
export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const logActivity = (fileId: number, f: { seconds?: number; highlights?: number; focus?: number }) =>
  run(
    `INSERT INTO activity(day, file_id, seconds, highlights, focus_min) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(day, file_id) DO UPDATE SET seconds=seconds+excluded.seconds,
       highlights=highlights+excluded.highlights, focus_min=focus_min+excluded.focus_min`,
    [today(), fileId, f.seconds ?? 0, f.highlights ?? 0, f.focus ?? 0],
  );

export interface FileRow {
  id: number; rel: string; size: number; mtime: number; hash: string | null;
  pages: number; last_page: number; max_page: number; thumb: string | null;
  color: string | null; stickers: string; cover: string | null;
  indexed_mtime: number | null; missing: number; opened_at: number | null; dirty: number;
}
export interface FolderRow {
  rel: string; color: string | null; stickers: string; cover: string | null;
  exam_date: string | null; exam_label: string | null;
}
export interface Color { id: number; name: string; hex: string }
export interface Tag { id: number; name: string; color: string }
export interface HighlightRow {
  id: string; file_id: number; page: number; rects: string; color_id: number;
  text: string; note: string; created_at: number;
}
export interface Highlight extends Omit<HighlightRow, "rects"> { rects: Rect[] }

export const parseHl = (h: HighlightRow): Highlight => ({ ...h, rects: JSON.parse(h.rects) });
export const colors = () => q<Color>(`SELECT * FROM colors ORDER BY id`);
