#!/usr/bin/env bash
# Crops the full-resolution screenshots to the parts shown in docs/USER_GUIDE.md.
# Usage: FULL_DIR=/some/dir ./scripts/screenshots.sh && ./scripts/crop-guide.sh /some/dir
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
full="${1:?directory with the full-resolution screenshots}"
out="$here/docs/images/guide"
mkdir -p "$out"

# name  source-stage  x  y  width  height   (pixels in the 2880x1608 capture)
crop() {
  swift "$here/scripts/crop.swift" "$full/$2.png" "$out/$1.png" "$3" "$4" "$5" "$6"
}
crop changes-panel     overview          96   72  600  696
crop change-labels     overview         696  144 1064  880
crop commit-panel      overview          96 1048  600  464
crop status-bar        overview           0 1562  610   46
crop toolbar           rollback-undo     96  136  600   40
crop leave-change-out  leave-change-out 696  432  904  208
crop partial-diff      partial-diff     696   72 2184  792
crop commit-options    commit-options    96 1048  600  480
crop shelf             shelf             96 1272  600  232
crop rollback-undo     rollback-undo   1960 1376  904  176
crop switch-active     switch-active    840    8 1208  496
crop explorer-markers  explorer-markers  96   72  600  584
crop tree-view         tree-view         96  144  600  896
ls "$out"
