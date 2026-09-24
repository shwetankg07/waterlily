#!/bin/sh
# Build and install for the current user: app menu entry + `waterlily` command. Remove with --uninstall.
set -e
BIN="$HOME/.local/bin/waterlily"
DESKTOP="$HOME/.local/share/applications/waterlily.desktop"
ICON="$HOME/.local/share/icons/hicolor/512x512/apps/waterlily.png"
if [ "$1" = "--uninstall" ]; then
  rm -f "$BIN" "$DESKTOP" "$ICON"
  echo "Removed. Your notes and highlights are untouched (app data: ~/.config/dev.waterlily.notes)."
  exit 0
fi
cd "$(dirname "$0")/.."
npx tauri build --no-bundle
install -Dm755 src-tauri/target/release/waterlily "$BIN"
install -Dm644 src-tauri/icons/icon.png "$ICON"
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=Waterlily
Comment=A cozy offline home for your PDF notes
Exec=$BIN
Icon=waterlily
Terminal=false
Categories=Education;Office;
StartupWMClass=waterlily
DESK
update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
echo "Installed. Open it from your app launcher, or run: waterlily"
