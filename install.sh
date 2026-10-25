#!/bin/sh
# Install the Gantry desktop app (Linux x64). Downloads the latest AppImage and
# puts a `gantry` command on your PATH. Re-run to reinstall; `gantry update` to upgrade.
#   curl -fsSL https://github.com/amriteshdasgupta/gantry/releases/latest/download/install.sh | sh
set -e

URL="${GANTRY_APPIMAGE_URL:-https://github.com/amriteshdasgupta/gantry/releases/latest/download/Gantry-x86_64.AppImage}"
OPT="$HOME/.local/opt"
BIN="$HOME/.local/bin"
APP="$OPT/Gantry.AppImage"

mkdir -p "$OPT" "$BIN"

echo "Downloading Gantry…"
curl -fL "$URL" -o "$APP.tmp"
chmod +x "$APP.tmp"
mv "$APP.tmp" "$APP"

cat > "$BIN/gantry" <<'LAUNCHER'
#!/bin/sh
APP="$HOME/.local/opt/Gantry.AppImage"
if [ "$1" = "update" ]; then
  echo "Updating Gantry…"
  curl -fL "https://github.com/amriteshdasgupta/gantry/releases/latest/download/Gantry-x86_64.AppImage" -o "$APP.tmp" \
    && chmod +x "$APP.tmp" && mv "$APP.tmp" "$APP" && echo "Updated." || { echo "Update failed."; rm -f "$APP.tmp"; exit 1; }
  exit 0
fi
if command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; then
  exec "$APP" "$@"
else
  exec "$APP" --appimage-extract-and-run "$@"
fi
LAUNCHER
chmod +x "$BIN/gantry"

echo "Installed. Launch it with:  gantry   (update later with:  gantry update)"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH, e.g.:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile" ;;
esac
