#!/usr/bin/env bash

# Updates this fork's macOS install: packages the desktop client as an arm64
# DMG into /Applications, builds the headless server from this checkout, and
# installs a LaunchAgent that serves it with Tailscale Serve, and installs this
# fork's user-wide agent skills. Packaged Desktop then attaches to that service
# instead of starting a second backend.

set -euo pipefail

# GUI launches and non-interactive SSH sessions do not load the user's shell
# startup files. Establish the locations used by this fork before invoking any
# build tools so the updater behaves the same way from either entry point.
export PATH="$HOME/.local/share/mise/shims:$HOME/.vite-plus/bin:$HOME/.local/share/vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="$repo_root/release"
mount_dir=""
device=""
version_backup_dir=""
plist_tmp=""
service_launcher_tmp=""
staged_app_dir=""
release_package_files=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)

require_tool() {
  local tool=$1
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool not found: $tool" >&2
    exit 1
  fi
}

verify_launchctl_handoff() {
  local label="com.netpro2k.t3code.update-preflight.$(date +%s).$$"
  local attempt

  if ! launchctl submit -l "$label" -- /bin/sleep 30; then
    echo "Unable to submit a temporary launchd job for the update handoff." >&2
    return 1
  fi
  if ! launchctl remove "$label"; then
    echo "Unable to remove the temporary launchd handoff job $label." >&2
    return 1
  fi
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Temporary launchd handoff job $label remained loaded after removal." >&2
  return 1
}

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
  if [[ -n "$staged_app_dir" && -d "$staged_app_dir" ]]; then
    rm -rf "$staged_app_dir"
  fi

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

for tool in node vp git hdiutil ditto launchctl; do
  require_tool "$tool"
done
node_path="$(node -p 'process.execPath')"
vp_path="$(type -P vp)"
if [[ ! -x "$node_path" || ! -x "$vp_path" ]]; then
  echo "Resolved build tools are not executable: node=$node_path vp=$vp_path" >&2
  exit 1
fi
verify_launchctl_handoff

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

"$node_path" scripts/update-release-package-versions.ts "$release_version"
"$node_path" scripts/build-desktop-artifact.ts \
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

# Stage the complete bundle on the destination filesystem. The detached
# cutover job closes Desktop before atomically putting this bundle in place.
staged_app_dir="$(mktemp -d "/Applications/.t3code-update.XXXXXX")"
staged_app="$staged_app_dir/T3 Code (Alpha).app"
ditto "$source_app" "$staged_app"

xml_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  printf '%s' "$value"
}

server_entry="$repo_root/apps/server/dist/bin.mjs"
if [[ ! -f "$server_entry" ]]; then
  echo "Building the headless server at $server_entry" >&2
  "$node_path" apps/server/scripts/cli.ts build
fi
if [[ ! -f "$server_entry" ]]; then
  echo "Headless server entry missing after build: $server_entry" >&2
  exit 1
fi
install_user_t3_shim "$server_entry"
bash "$repo_root/scripts/install-user-agent-skill.sh" \
  "$repo_root/apps/server/resources/skills/manage-t3-threads" \
  "$HOME"

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
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
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

# Run the final replacement as a separate LaunchAgent. The current script can
# be a descendant of the server LaunchAgent it is about to unload.
handoff_label="com.netpro2k.t3code.update.$(date +%s).$$"
handoff_service_target="${domain_target}/${handoff_label}"
handoff_log="$HOME/.t3/userdata/logs/update.log"
handoff_status="$HOME/.t3/userdata/logs/${handoff_label}.status"
printf 'pending\n' >"$handoff_status"
handoff_staged_app_dir=$staged_app_dir
handoff_service_launcher_tmp=$service_launcher_tmp
handoff_server_plist_tmp=$plist_tmp
staged_app_dir=""
service_launcher_tmp=""
plist_tmp=""
if ! launchctl submit -l "$handoff_label" -o "$handoff_log" -e "$handoff_log" -- \
  /usr/bin/env "HOME=$HOME" "PATH=$environment_path" \
  /bin/bash "$repo_root/scripts/complete-mac-update.sh" \
  "$repo_root" "$node_path" "$server_entry" \
  "$staged_app" "$destination_app" \
  "$handoff_service_launcher_tmp" "$service_launcher" \
  "$handoff_server_plist_tmp" "$plist_path" "$legacy_plist_path" \
  "$domain_target" "$service_target" "$legacy_service_target" "$handoff_service_target" \
  "$handoff_status"; then
  rm -rf "$handoff_staged_app_dir"
  rm -f "$handoff_service_launcher_tmp" "$handoff_server_plist_tmp"
  printf 'failed\n' >"$handoff_status"
  exit 1
fi

# The handoff agent owns these staged paths now. Keep the DMG cleanup active.

echo "Staged T3 Code $release_version fork commit $(git rev-parse --short HEAD) from $repo_root"
echo "Cutover continues in LaunchAgent $handoff_label; the current T3 thread may disconnect briefly."
echo "Follow it with: tail -f $handoff_log"
echo "Result file: $handoff_status"
