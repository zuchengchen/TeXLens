#!/usr/bin/env sh
set -eu

tauri_cache_dir="${TAURI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tauri}"
linuxdeploy_appimage="$tauri_cache_dir/linuxdeploy-x86_64.AppImage"
runtime_file="$tauri_cache_dir/runtime-x86_64"

if [ -x "$linuxdeploy_appimage" ] && [ ! -s "$runtime_file" ]; then
  runtime_offset="$("$linuxdeploy_appimage" --appimage-offset 2>/dev/null || true)"
  case "$runtime_offset" in
    ''|*[!0-9]*)
      ;;
    *)
      dd if="$linuxdeploy_appimage" of="$runtime_file" bs=1 count="$runtime_offset" status=none
      chmod +x "$runtime_file"
      ;;
  esac
fi

if [ -s "$runtime_file" ]; then
  export LDAI_RUNTIME_FILE="$runtime_file"
fi

exec tauri build "$@"
