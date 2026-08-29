#!/usr/bin/env bash

# Updates this fork's macOS install: packages the desktop client as an arm64
# DMG into /Applications, builds the headless server from this checkout, and
# installs a LaunchAgent that serves it with Tailscale Serve — the same model
# as scripts/update-linux.sh. Packaged Desktop then attaches to that service
# instead of starting a second backend.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="$repo_root/release"
mount_dir=""
device=""
version_backup_dir=""
plist_tmp=""
service_launcher_tmp=""
release_package_files=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)

select_release_tag() {
  local nearest_tag
  local tagged_commit
  local candidate
  local nightly_fallback=""

  nearest_tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)" || return
  tagged_commit="$(git rev-parse "${nearest_tag}^{commit}")"

  while IFS= read -r candidate; do
    if [[ -z "$nightly_fallback" ]]; then
      nightly_fallback=$candidate
    fi
    if [[ "$candidate" != *-nightly.* ]]; then
      printf '%s' "$candidate"
      return
    fi
  done < <(
    git tag --points-at "$tagged_commit" --list 'v[0-9]*' \
      --sort=-version:refname
  )

  printf '%s' "${nightly_fallback:-$nearest_tag}"
}

install_user_t3_shim() {
  local server_entry=$1
  local bin_dir="$HOME/.local/bin"
  local shim_path="$bin_dir/t3"
  local stage_dir

  mkdir -p "$bin_dir"
  if [[ -d "$shim_path" ]]; then
    echo "Refusing to replace directory at $shim_path" >&2
    return 1
  fi

  stage_dir="$(mktemp -d "$bin_dir/.t3-shim.XXXXXX")"
  ln -s "$server_entry" "$stage_dir/t3"
  if ! mv -f "$stage_dir/t3" "$shim_path"; then
    rm -f "$stage_dir/t3"
    rmdir "$stage_dir"
    return 1
  fi
  rmdir "$stage_dir"
}

launchd_service_pid() {
  local target=$1
  launchctl print "$target" 2>/dev/null | awk '
    $1 == "pid" && $2 == "=" && $3 ~ /^[0-9]+$/ { print $3; exit }
  '
}

wait_for_pid_exit() {
  local pid=$1
  local description=$2
  local attempt

  for ((attempt = 0; attempt < 90; attempt += 1)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return
    fi
    sleep 1
  done

  echo "$description was unloaded, but pid $pid did not exit within 90 seconds." >&2
  echo "Refusing to start another T3 Code server alongside it." >&2
  return 1
}

stop_launchd_service() {
  local target=$1
  local pid

  if ! launchctl print "$target" >/dev/null 2>&1; then
    return
  fi

  pid="$(launchd_service_pid "$target")"
  echo "Stopping $target${pid:+ (pid $pid)}"
  launchctl bootout "$target"

  if launchctl print "$target" >/dev/null 2>&1; then
    echo "LaunchAgent $target is still loaded after bootout." >&2
    return 1
  fi
  if [[ -n "$pid" ]]; then
    wait_for_pid_exit "$pid" "LaunchAgent $target"
  fi
}

assert_no_live_runtime_server() {
  local runtime_state_path="$HOME/.t3/userdata/server-runtime.json"
  local runtime_pid

  if [[ ! -f "$runtime_state_path" ]]; then
    return
  fi

  runtime_pid="$(node -e '
    const fs = require("node:fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Number.isSafeInteger(state.pid) && state.pid > 0) {
        process.stdout.write(String(state.pid));
      }
    } catch {}
  ' "$runtime_state_path")"

  if [[ -n "$runtime_pid" ]] && kill -0 "$runtime_pid" 2>/dev/null; then
    echo "T3 Code server pid $runtime_pid still owns $runtime_state_path." >&2
    echo "Refusing to start the LaunchAgent until that server has exited." >&2
    return 1
  fi
}

restore_release_package_versions() {
  if [[ -z "$version_backup_dir" ]]; then
    return
  fi
  for package_file in "${release_package_files[@]}"; do
    cp "$version_backup_dir/$package_file" "$package_file"
  done
  rm -r "$version_backup_dir"
  version_backup_dir=""
}

cleanup() {
  local status=$?
  rm -f "${plist_tmp:-}"
  rm -f "${service_launcher_tmp:-}"

  if ! restore_release_package_versions; then
    status=1
  fi

  if [[ -n "$device" ]]; then
    hdiutil detach "$device" >/dev/null || true
  elif [[ -n "$mount_dir" && -d "$mount_dir" ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  if [[ -n "$mount_dir" && -d "$mount_dir" ]]; then
    rmdir "$mount_dir" 2>/dev/null || true
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo_root"

git fetch upstream --tags

if ! release_tag="$(select_release_tag)"; then
  echo "Unable to find a release tag for $(git rev-parse --short HEAD)" >&2
  exit 1
fi
release_version="${release_tag#v}"
release_version="${release_version%%-nightly.*}"
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid release version derived from $release_tag: $release_version" >&2
  exit 1
fi
echo "Building T3 Code $release_version from $(git rev-parse --short HEAD)"

# Release package versions are injected by CI rather than committed at the
# release tag. Reproduce that step locally, restoring the checkout afterward.
version_backup_dir="$(mktemp -d)"
for package_file in "${release_package_files[@]}"; do
  mkdir -p "$version_backup_dir/$(dirname "$package_file")"
  cp "$package_file" "$version_backup_dir/$package_file"
done

node scripts/update-release-package-versions.ts "$release_version"
node scripts/build-desktop-artifact.ts \
  --platform mac \
  --target dmg \
  --arch arm64 \
  --build-version "$release_version"
restore_release_package_versions

shopt -s nullglob
dmgs=("$release_dir"/*arm64.dmg)
shopt -u nullglob

if (( ${#dmgs[@]} == 0 )); then
  echo "No ARM64 DMG found in $release_dir" >&2
  exit 1
fi

dmg="${dmgs[0]}"
for candidate in "${dmgs[@]:1}"; do
  if [[ "$candidate" -nt "$dmg" ]]; then
    dmg="$candidate"
  fi
done

# A failed attach can leave this exact image mounted at its automatic volume
# path. Detach only attachments for the DMG we are about to install; unrelated
# disk images must not be disturbed.
existing_devices="$(hdiutil info | awk -v image="$dmg" '
  $1 == "image-path" { same_image = substr($0, index($0, ":") + 2) == image }
  same_image && $1 ~ /^\/dev\/disk[0-9]+$/ {
    print $1
    same_image = 0
  }
')"
while IFS= read -r existing_device; do
  if [[ -n "$existing_device" ]]; then
    hdiutil detach "$existing_device" >/dev/null
  fi
done <<<"$existing_devices"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-dmg.XXXXXX")"
attach_output="$(hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir")"
device="$(awk '$1 ~ /^\/dev\// { print $1; exit }' <<<"$attach_output")"

if [[ -z "$device" ]]; then
  echo "Could not determine the mounted DMG device" >&2
  exit 1
fi

source_app="$mount_dir/T3 Code (Alpha).app"
destination_app="/Applications/T3 Code (Alpha).app"

if [[ ! -d "$source_app" ]]; then
  echo "App bundle not found in DMG: $source_app" >&2
  exit 1
fi

ditto "$source_app" "$destination_app"
echo "Installed T3 Code $release_version at $destination_app from $dmg"

xml_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  printf '%s' "$value"
}

node_path="$(node -p 'process.execPath')"
server_entry="$repo_root/apps/server/dist/bin.mjs"
if [[ ! -f "$server_entry" ]]; then
  echo "Building the headless server at $server_entry" >&2
  node apps/server/scripts/cli.ts build
fi
if [[ ! -f "$server_entry" ]]; then
  echo "Headless server entry missing after build: $server_entry" >&2
  exit 1
fi
install_user_t3_shim "$server_entry"

# HTTPS port already published on this tailnet. The server tears the old
# mapping down on stop and points it at the new listen port on start.
tailscale_serve_port=8443
launcher_log="$HOME/.t3/userdata/logs/boot-service.log"
service_name="T3 Code server (netpro2k fork)"
plist_label="com.netpro2k.t3code.server"
legacy_plist_label="com.t3tools.t3code.service"
plist_dir="$HOME/Library/LaunchAgents"
plist_path="$plist_dir/${plist_label}.plist"
legacy_plist_path="$plist_dir/${legacy_plist_label}.plist"
service_launcher_dir="$HOME/.local/libexec"
service_launcher="$service_launcher_dir/$service_name"
uid="$(id -u)"
domain_target="gui/${uid}"
service_target="${domain_target}/${plist_label}"
legacy_service_target="${domain_target}/${legacy_plist_label}"
node_bin="$(cd "$(dirname "$node_path")" && pwd)"
environment_path="${node_bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$HOME/.t3/userdata/logs" "$plist_dir" "$service_launcher_dir"

# System Settings attributes a directly launched, signed Node executable to
# Node.js Foundation. Use an unsigned, descriptively named launcher so macOS
# presents this fork service by name under General -> Login Items.
service_launcher_tmp="$(mktemp "$service_launcher_dir/.t3code-server.XXXXXX")"
cat >"$service_launcher_tmp" <<'LAUNCHER'
#!/bin/sh
exec "$T3CODE_NODE_PATH" "$T3CODE_SERVER_ENTRY" "$@"
LAUNCHER
chmod +x "$service_launcher_tmp"
mv -f "$service_launcher_tmp" "$service_launcher"
service_launcher_tmp=""

plist_tmp="$(mktemp "${plist_dir}/.${plist_label}.XXXXXX")"

cat >"$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plist_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$service_launcher")</string>
    <string>serve</string>
    <string>--tailscale-serve</string>
    <string>--tailscale-serve-port</string>
    <string>${tailscale_serve_port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$environment_path")</string>
    <key>T3CODE_NODE_PATH</key>
    <string>$(xml_escape "$node_path")</string>
    <key>T3CODE_SERVER_ENTRY</key>
    <string>$(xml_escape "$server_entry")</string>
    <key>T3CODE_HOME</key>
    <string>$(xml_escape "$HOME/.t3")</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>90</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$launcher_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$launcher_log")</string>
</dict>
</plist>
PLIST

# Stop any previous agent only after the new app and server bundle are ready.
# Probe before bootout so "not loaded" is the only ignored case. In particular,
# never hide an unsupported launchctl flag or a failed stop: starting the new
# KeepAlive job while either old job survives creates two database writers.
stop_launchd_service "$service_target"
stop_launchd_service "$legacy_service_target"
assert_no_live_runtime_server
mv -f "$plist_tmp" "$plist_path"
plist_tmp=""
rm -f "$legacy_plist_path"
launchctl enable "$service_target" 2>/dev/null || true
if ! launchctl bootstrap "$domain_target" "$plist_path"; then
  echo "Launch agent written to $plist_path but bootstrap failed." >&2
  echo "That is expected over SSH with nobody at the Mac's screen; it starts at the next login." >&2
fi

echo "Installed T3 Code $release_version fork commit $(git rev-parse --short HEAD) from $repo_root"
echo "Desktop app: $destination_app"
echo "Launch agent: $service_name ($plist_path)"
echo "Tailscale Serve HTTPS port: $tailscale_serve_port"
echo "CLI: $HOME/.local/bin/t3 -> $server_entry"
