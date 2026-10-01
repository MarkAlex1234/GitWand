#!/usr/bin/env bash
# Fail if an AppImage contains a file or directory that only its owner (or
# group) can use.
#
# The FUSE mount of a normally started AppImage shows every file as owned by
# the user who started it, so an owner-only mode never bites there. It does
# when root mounts the image and someone else runs it: `firejail --appimage`
# does exactly that, and so does the AppImage catalog's test (appimage.github.io
# PR #7392). GitWand 3.11.1 shipped `AppRun.wrapped` as 0770 — the launcher the
# Tauri bundler writes with `from_mode(0o770)` (tauri-apps/tauri#16155) — and
# the catalog got `AppRun.wrapped: Permission denied` and an app that never
# started.
#
# Rule: anything executable by its owner must be executable by others, and
# every file and directory must be readable by others.
#
# The modes are read from the SquashFS listing (`unsquashfs -lln`), which is
# what a mount shows. `--appimage-extract` is not used: the extraction is done
# by the image's own runtime, so the modes it writes are the runtime's, not
# necessarily the ones stored in the image.
#
# Requires squashfs-tools.
# Usage:  bash scripts/check-appimage-modes.sh <file.AppImage>
set -euo pipefail

image="${1:?usage: $0 <file.AppImage>}"

# The image may not be executable yet (e.g. downloaded from an artifact).
[ -x "$image" ] || chmod +x "$image"
offset="$("$(realpath "$image")" --appimage-offset)"

listing="$(unsquashfs -lln -o "$offset" "$image")"

# `-lln` lines: "<mode> <uid>/<gid> <size> <date> <time> squashfs-root/<path>".
# Symlinks (mode starting with "l") are always 0777 and are skipped.
bad="$(awk '
  $1 ~ /^[-d]/ {
    m = $1
    owner_x = substr(m, 4, 1) ~ /[xs]/
    other_r = substr(m, 8, 1) == "r"
    other_x = substr(m, 10, 1) ~ /[xt]/
    if ((owner_x && !other_x) || !other_r) {
      path = $0; sub(/^.*squashfs-root\/?/, "", path)
      print m, path
    }
  }' <<<"$listing")"

if [ -n "$bad" ]; then
  echo "::error::AppImage has owner-only modes; it will not start when another user runs it (e.g. firejail --appimage):"
  echo "$bad"
  exit 1
fi

echo "✓ every file in $(basename "$image") is usable by any user ($(wc -l <<<"$listing") entries)"
