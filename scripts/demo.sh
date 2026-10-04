#!/usr/bin/env bash
# Opens the demo (src/integration/demo.ts) in an isolated instance of the installed VS Code against a throwaway repo.
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
mkdir -p "$repo/src/auth"; printf 'export const login = 1;\n' > "$repo/src/auth/login.ts"; printf 'export const session = 0;\n' > "$repo/src/auth/session.ts"; printf 'export const api = 1;\n' > "$repo/src/api.ts"; printf 'export const config = 1;\n' > "$repo/src/config.ts"; printf '# Demo\n' > "$repo/README.md"
git -C "$repo" add . && git -C "$repo" commit -qm init
mkdir -p "$tmp/user/User"
echo '{ "security.workspace.trust.enabled": false, "git.openRepositoryInParentFolders": "always" }' > "$tmp/user/User/settings.json"
echo '{}' > "$repo/.vscode/settings.json"
# The Electron binary (not the `code` CLI) returns the test's exit code.
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
"$CODE" --new-window --disable-extensions --skip-welcome --skip-release-notes \
  --user-data-dir "$tmp/user" --extensions-dir "$tmp/ext" \
  --extensionDevelopmentPath="$here" --extensionTestsPath="$here/out/integration/demo" "$repo"
