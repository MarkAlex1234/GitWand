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
# Usage:  bash scripts/check-appimage-modes.sh <file.AppImage | extracted-dir>
set -euo pipefail

target="${1:?usage: $0 <file.AppImage | extracted-dir>}"

if [ -d "$target" ]; then
  root="$target"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  cp "$target" "$work/image.AppImage"
  chmod +x "$work/image.AppImage"
  # Extraction keeps the modes stored in the SquashFS, which is what we check.
  (cd "$work" && ./image.AppImage --appimage-extract >/dev/null)
  root="$work/squashfs-root"
fi

bad="$(find "$root" \( -type f -o -type d \) \
  \( \( -perm -u+x ! -perm -o+x \) -o ! -perm -o+r \) \
  -printf '%M %P\n')"

if [ -n "$bad" ]; then
  echo "::error::AppImage has owner-only modes; it will not start when another user runs it (e.g. firejail --appimage):"
  echo "$bad"
  exit 1
fi

echo "✓ every file in $(basename "$target") is usable by any user"
