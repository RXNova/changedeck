#!/usr/bin/env bash
# Runs src/integration in an isolated instance of the installed VS Code against a throwaway repo.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/.vscode"
git -C "$repo" init -q -b main
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
git -C "$repo" config commit.gpgsign false
echo ".vscode/" >> "$repo/.git/info/exclude"
printf 'a\n' > "$repo/a.txt"
printf 'b\n' > "$repo/b.txt"
git -C "$repo" add . && git -C "$repo" commit -qm init
mkdir -p "$tmp/user/User"
echo '{ "security.workspace.trust.enabled": false, "git.openRepositoryInParentFolders": "always" }' > "$tmp/user/User/settings.json"
echo '{}' > "$repo/.vscode/settings.json"
# The Electron binary (not the `code` CLI) returns the test's exit code.
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
"$CODE" --new-window --disable-extensions --skip-welcome --skip-release-notes \
  --user-data-dir "$tmp/user" --extensions-dir "$tmp/ext" \
  --extensionDevelopmentPath="$here" --extensionTestsPath="$here/out/integration/index" "$repo"
