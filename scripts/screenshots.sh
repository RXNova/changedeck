#!/usr/bin/env bash
# macOS only. Opens a mock project in an isolated VS Code window, walks through the features
# (src/integration/screenshots.ts) and saves one screenshot per stage to docs/images/.
# Only that window is captured (by window ID), never the rest of the screen.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
stages="${TMPDIR%/}/changedeck-screenshots"
out="$here/docs/images"
trap 'rm -rf "$tmp" "$stages"' EXIT
rm -rf "$stages"; mkdir -p "$out"

repo="$tmp/shop-api"
mkdir -p "$repo/.vscode"
git -C "$repo" init -q -b main
git -C "$repo" config user.email alex@example.com
git -C "$repo" config user.name "Alex Rivera"
git -C "$repo" config commit.gpgsign false
echo ".vscode/" >> "$repo/.git/info/exclude"
echo '{}' > "$repo/.vscode/settings.json"
mkdir -p "$tmp/user/User"
cat > "$tmp/user/User/settings.json" <<'JSON'
{
  "security.workspace.trust.enabled": false,
  "git.openRepositoryInParentFolders": "always",
  "workbench.startupEditor": "none",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  "editor.minimap.enabled": false,
  "typescript.validate.enable": false,
  "javascript.validate.enable": false,
  "workbench.tips.enabled": false,
  "update.mode": "none"
}
JSON

CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
"$CODE" --new-window --disable-extensions --skip-welcome --skip-release-notes \
  --user-data-dir "$tmp/user" --extensions-dir "$tmp/ext" \
  --extensionDevelopmentPath="$here" --extensionTestsPath="$here/out/integration/screenshots" "$repo" >"$tmp/code.log" 2>&1 &
pid=$!

last=""
for _ in $(seq 1 1200); do
  sleep 0.1
  kill -0 "$pid" 2>/dev/null || break
  [ -f "$stages/stage" ] || continue
  stage="$(cat "$stages/stage")"
  [ "$stage" = "$last" ] && continue
  last="$stage"
  [ "$stage" = "done" ] && break
  id="$(swift "$here/scripts/window-id.swift" 2>/dev/null || true)"
  if [ -n "$id" ]; then
    screencapture -x -o -l "$id" "$tmp/shot.png"
    sips -Z 1800 "$tmp/shot.png" --out "$out/$stage.png" >/dev/null
    # FULL_DIR keeps the full-resolution captures, which scripts/crop-guide.sh crops for the user guide.
    if [ -n "${FULL_DIR:-}" ]; then mkdir -p "$FULL_DIR"; cp "$tmp/shot.png" "$FULL_DIR/$stage.png"; fi
    echo "captured $stage"
  else
    echo "window not found for $stage" >&2
  fi
  touch "$stages/ack-$stage"
done
wait "$pid" 2>/dev/null || true
grep -iE "TypeError|Error:" "$tmp/code.log" | grep -v DEP0 | head -5 || true
