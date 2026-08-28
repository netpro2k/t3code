#!/usr/bin/env bash

# Runs as a transient user service so stopping t3code.service cannot terminate
# the updater that is responsible for starting its replacement.

set -euo pipefail

if (( $# != 10 )); then
  echo "Usage: $0 <repo> <node> <server> <appimage-tmp> <appimage> <desktop-tmp> <desktop> <icon-tmp> <icon> <unit-tmp>" >&2
  exit 2
fi

repo_dir=$1
node_path=$2
server_entry=$3
appimage_tmp=$4
appimage_path=$5
desktop_entry_tmp=$6
desktop_entry_path=$7
icon_tmp=$8
icon_path=$9
unit_tmp=${10}
server_stopped=false
desktop_was_running=false

cleanup() {
  local status=$?

  if [[ "$server_stopped" == true ]] && ! systemctl --user is-active --quiet t3code.service; then
    systemctl --user start t3code.service >/dev/null 2>&1 || true
  fi
  if [[ "$desktop_was_running" == true ]]; then
    systemd-run --user --collect \
      --unit="t3code-desktop-relaunch-$(date +%s)-$$" \
      "$appimage_path" >/dev/null 2>&1 || true
  fi
  rm -f "$appimage_tmp" "$desktop_entry_tmp" "$icon_tmp" "$unit_tmp"
  exit "$status"
}
trap cleanup EXIT

desktop_state="$($node_path "$repo_dir/scripts/prepare-desktop-update.ts" "$HOME/.t3")"
case "$desktop_state" in
  stopped) desktop_was_running=true ;;
  not-running) ;;
  *)
    echo "Unexpected desktop update state: $desktop_state" >&2
    exit 1
    ;;
esac

# The desktop is now closed, so every user-visible artifact can be replaced
# without racing a running Electron process.
mv -f "$appimage_tmp" "$appimage_path"
mv -f "$desktop_entry_tmp" "$desktop_entry_path"
mv -f "$icon_tmp" "$icon_path"
command -v update-desktop-database >/dev/null && \
  update-desktop-database "$(dirname "$desktop_entry_path")"

systemctl --user stop t3code.service
server_stopped=true
if systemctl --user is-active --quiet t3code.service; then
  echo "t3code.service is still active after systemctl stop." >&2
  echo "Refusing to start another T3 Code server alongside it." >&2
  exit 1
fi

runtime_state_path="$HOME/.t3/userdata/server-runtime.json"
if [[ -f "$runtime_state_path" ]]; then
  runtime_pid="$($node_path -e '
    const fs = require("node:fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Number.isSafeInteger(state.pid) && state.pid > 0) process.stdout.write(String(state.pid));
    } catch {}
  ' "$runtime_state_path")"
  if [[ -n "$runtime_pid" ]] && kill -0 "$runtime_pid" 2>/dev/null; then
    echo "T3 Code server pid $runtime_pid still owns $runtime_state_path." >&2
    echo "Refusing to start the systemd unit until that server has exited." >&2
    exit 1
  fi
fi

"$node_path" "$repo_dir/scripts/provision-desktop-session.ts" "$server_entry" "$HOME/.t3"
mv -f "$unit_tmp" "$HOME/.config/systemd/user/t3code.service"
systemctl --user daemon-reload
systemctl --user enable --now t3code.service
server_stopped=false

if [[ "$desktop_was_running" == true ]]; then
  systemd-run --user --collect \
    --unit="t3code-desktop-relaunch-$(date +%s)-$$" \
    "$appimage_path" >/dev/null
  desktop_was_running=false
fi

systemctl --user --no-pager --full status t3code.service
echo "T3 Code update cutover completed."
