#!/usr/bin/env bash

# Runs as a temporary LaunchAgent so unloading the T3 server LaunchAgent cannot
# terminate the updater that is responsible for bootstrapping its replacement.

set -euo pipefail

if (( $# != 15 )); then
  echo "Usage: $0 <repo> <node> <server> <staged-app> <app> <launcher-tmp> <launcher> <plist-tmp> <plist> <legacy-plist> <domain> <service> <legacy-service> <handoff-service> <status-file>" >&2
  exit 2
fi

repo_root=$1
node_path=$2
server_entry=$3
staged_app=$4
destination_app=$5
service_launcher_tmp=$6
service_launcher=$7
plist_tmp=$8
plist_path=$9
legacy_plist_path=${10}
domain_target=${11}
service_target=${12}
legacy_service_target=${13}
handoff_service_target=${14}
status_path=${15}
server_stopped=false
desktop_was_running=false
app_replaced=false
app_backup=""
staged_app_dir="$(dirname "$staged_app")"

case "$staged_app_dir" in
  /Applications/.t3code-update.*) ;;
  *)
    echo "Refusing unexpected staged app directory: $staged_app_dir" >&2
    exit 1
    ;;
esac
if [[ "$destination_app" != "/Applications/T3 Code (Alpha).app" ]]; then
  echo "Refusing unexpected destination app path: $destination_app" >&2
  exit 1
fi

write_status() {
  local state=$1
  local status_tmp="${status_path}.tmp.$$"
  printf '%s\n' "$state" >"$status_tmp"
  mv -f "$status_tmp" "$status_path"
}

launchd_service_pid() {
  launchctl print "$1" 2>/dev/null | awk '
    $1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }
  '
}

wait_for_pid_exit() {
  local pid=$1
  local description=$2
  local attempt
  for ((attempt = 0; attempt < 90; attempt += 1)); do
    if ! kill -0 "$pid" 2>/dev/null; then return; fi
    sleep 1
  done
  echo "$description was unloaded, but pid $pid did not exit within 90 seconds." >&2
  return 1
}

stop_launchd_service() {
  local target=$1
  local pid
  local attempt
  if ! launchctl print "$target" >/dev/null 2>&1; then return; fi
  pid="$(launchd_service_pid "$target")"
  echo "Stopping $target${pid:+ (pid $pid)}"
  launchctl bootout "$target"
  for ((attempt = 0; attempt < 90; attempt += 1)); do
    if ! launchctl print "$target" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if launchctl print "$target" >/dev/null 2>&1; then
    echo "LaunchAgent $target is still loaded after bootout." >&2
    return 1
  fi
  if [[ -n "$pid" ]]; then wait_for_pid_exit "$pid" "LaunchAgent $target"; fi
}

wait_for_server_ready() {
  local attempt
  local service_pid
  for ((attempt = 0; attempt < 90; attempt += 1)); do
    service_pid="$(launchd_service_pid "$service_target")"
    if [[ -n "$service_pid" ]] && "$node_path" -e '
      const fs = require("node:fs");
      const [statePath, expectedPid] = process.argv.slice(1);
      void (async () => {
        try {
          const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
          if (String(state.pid) !== expectedPid) process.exit(1);
          const response = await fetch(`${state.origin}/.well-known/t3/environment`);
          process.exit(response.ok ? 0 : 1);
        } catch {
          process.exit(1);
        }
      })();
    ' "$HOME/.t3/userdata/server-runtime.json" "$service_pid"; then
      return
    fi
    sleep 1
  done
  echo "T3 Code server did not become ready within 90 seconds." >&2
  return 1
}

cleanup() {
  local status=$?
  if [[ "$server_stopped" == true ]] && [[ -f "$plist_path" ]]; then
    launchctl bootstrap "$domain_target" "$plist_path" >/dev/null 2>&1 || true
  fi
  if (( status != 0 )) && [[ "$app_replaced" == true ]] && [[ -e "$app_backup" ]]; then
    rm -rf "$destination_app"
    mv "$app_backup" "$destination_app"
    app_replaced=false
  fi
  if [[ "$desktop_was_running" == true ]] && [[ -d "$destination_app" ]]; then
    open "$destination_app" >/dev/null 2>&1 || true
  fi
  rm -rf "$staged_app_dir"
  rm -f "$service_launcher_tmp" "$plist_tmp"
  if (( status != 0 )); then write_status failed || true; fi
  # Remove the submitted job before launchd can interpret a failure as a reason
  # to run this one-shot cutover again. This is intentionally the final action:
  # launchctl may terminate the current process as it removes the job.
  trap - EXIT
  launchctl remove "${handoff_service_target##*/}" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
write_status running

desktop_state="$($node_path "$repo_root/scripts/prepare-desktop-update.ts" "$HOME/.t3")"
case "$desktop_state" in
  stopped) desktop_was_running=true ;;
  not-running) ;;
  *)
    echo "Unexpected desktop update state: $desktop_state" >&2
    exit 1
    ;;
esac

# The staged bundle lives beside /Applications, so the final rename is atomic.
app_backup="${destination_app}.update-backup.$$"
if [[ -e "$destination_app" ]]; then mv "$destination_app" "$app_backup"; fi
if ! mv "$staged_app" "$destination_app"; then
  if [[ -e "$app_backup" ]]; then mv "$app_backup" "$destination_app"; fi
  exit 1
fi
app_replaced=true

server_stopped=true
stop_launchd_service "$service_target"
stop_launchd_service "$legacy_service_target"

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
    echo "Refusing to start the LaunchAgent until that server has exited." >&2
    exit 1
  fi
fi

mv -f "$service_launcher_tmp" "$service_launcher"
mv -f "$plist_tmp" "$plist_path"
rm -f "$legacy_plist_path"
launchctl enable "$service_target" 2>/dev/null || true
if ! launchctl bootstrap "$domain_target" "$plist_path"; then
  echo "Launch agent written to $plist_path but bootstrap failed." >&2
  echo "It will start at the next GUI login." >&2
else
  wait_for_server_ready
  server_stopped=false
fi

if [[ "$desktop_was_running" == true ]]; then
  open "$destination_app"
  desktop_was_running=false
fi
if [[ -e "$app_backup" ]]; then rm -rf "$app_backup"; fi
app_replaced=false
write_status succeeded

echo "T3 Code update cutover completed."
