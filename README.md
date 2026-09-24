# tbd ✿

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
- Ink drawings and stamps made in other apps aren't shown in the reader (they stay in the file).
- Links inside PDFs aren't clickable yet.
- Renaming a folder outside the app loses its decorations.

## License

MIT
