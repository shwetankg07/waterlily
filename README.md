# Waterlily ✿

A cozy, fully offline home for your PDF notes. Highlight in colors that mean something, keep notes on your highlights, and organize your folders like a stationery desk.

## What it does

- **Highlight PDFs** in named colors (definition, important, formula…), with a note on any highlight. Keys `1`–`9` pick a color after selecting text.
- **Highlights live in the PDF.** They're saved as standard PDF annotations, so they show up in Edge, Adobe, Okular or on your phone. Highlights made in those apps are imported too.
- **Your folders, decorated.** The app mirrors your notes folder: subfolders become notebooks you can color, cover with a picture, stick emoji on and give an exam countdown. Moving things in the app moves them on disk.
- **Study modes:** *Quiz me* hides your highlights until you tap them; *Only highlights* shows just the highlighted parts of a PDF.
- **Search** across the text of every PDF, your highlights and your notes.
- **A streak garden** with a year graph, a 25-minute focus timer, reading progress, and five themes.

Nothing leaves your computer. No account, no internet needed.

## Where your data lives

- Highlights: inside your PDFs, plus the app database.
- Decorations, tags, notes, streaks: a SQLite database in the app's config folder. *Settings → Save a backup* copies it to a single file.
- The first time the app writes to a PDF, it keeps an untouched copy of the original in the app's data folder.

## Develop

Needs Node 24+, Rust stable, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev     # run the app
npm run check         # round-trips highlights through real PDFs
npx tauri build       # Windows: builds the setup.exe installer
```

Pushing a `v*` tag builds the Windows installer on GitHub Actions and attaches it to a release.

The installer isn't code-signed, so the first run shows "Windows protected your PC". Click **More info → Run anyway**.

## Known limits

- Typed/digital PDFs only; scanned pages have no text to select.
- Password-protected PDFs can't be opened. PDFs locked against editing open fine, but their highlights stay in the app instead of being written into the file.
- Links inside PDFs aren't clickable yet.
- Renaming a folder outside the app loses its decorations.

## Safety

- Before writing highlights into a PDF, the app first imports any highlights other apps added to it, so nothing is lost.
- Every write goes to a temporary file that is flushed to disk and checked with a second PDF reader before it replaces the original. If anything fails, the original is untouched and the highlights stay safe in the app.
- A write interrupted by a crash or power cut is finished the next time the app starts.

## License

MIT
