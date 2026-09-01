#!/usr/bin/env bash

# Updates this fork's Linux install end to end: pulls main unless --skip-pull
# is passed, rebuilds web + server into the t3code systemd unit, packages the
# desktop client, and installs this fork's user-wide agent skills.

set -euo pipefail

skip_pull=false

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--skip-pull" ]]; }; then
  echo "Usage: $0 [--skip-pull]" >&2
  exit 2
fi

if (( $# == 1 )); then
  skip_pull=true
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/t3code.service"

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

mkdir -p "$unit_dir"

cd "$repo_dir"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to update a dirty checkout at $repo_dir" >&2
  git status --short >&2
  exit 1
fi

if [[ "$skip_pull" == false ]]; then
  git fetch origin
  git switch main
  git pull --ff-only origin main
fi

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

if [[ ! -x "$HOME/.local/share/vite-plus/bin/vp" && ! -x "$HOME/.vite-plus/bin/vp" ]]; then
  curl -fsSL https://vite.plus | bash
fi

# Linux and macOS currently use different installer data directories. Export
# both so the current shell can use a freshly installed vp immediately.
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$PATH"
command -v vp >/dev/null

# The desktop build compiles native/resource-monitor with cargo.
export PATH="$HOME/.cargo/bin:$PATH"

vp i --frozen-lockfile

# Release package versions are injected by CI rather than committed at the
# release tag. Reproduce that step locally, restoring the checkout afterward.
release_package_files=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)
version_backup_dir="$(mktemp -d)"
for package_file in "${release_package_files[@]}"; do
  mkdir -p "$version_backup_dir/$(dirname "$package_file")"
  cp "$package_file" "$version_backup_dir/$package_file"
done

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
trap restore_release_package_versions EXIT

node scripts/update-release-package-versions.ts "$release_version"
vp run --filter @t3tools/web build
node apps/server/scripts/cli.ts build

# Package the desktop client from the dists above (--skip-build) so the local
# AppImage tracks this fork instead of the official update feed.
case "$(uname -m)" in
  x86_64) desktop_arch=x64 ;;
  aarch64) desktop_arch=arm64 ;;
  *)
    echo "Unsupported architecture for the desktop build: $(uname -m)" >&2
    exit 1
    ;;
esac
vp run --filter @t3tools/desktop build
node scripts/build-desktop-artifact.ts \
  --platform linux \
  --target AppImage \
  --arch "$desktop_arch" \
  --build-version "$release_version" \
  --skip-build

restore_release_package_versions
trap - EXIT

# electron-builder names AppImages after the host triplet (x86_64/aarch64).
shopt -s nullglob
built_artifacts=("$repo_dir/release"/T3-Code-*.AppImage)
shopt -u nullglob
if [[ ${#built_artifacts[@]} -eq 0 ]]; then
  echo "No AppImage produced in $repo_dir/release" >&2
  exit 1
fi
arch_artifacts=()
for artifact in "${built_artifacts[@]}"; do
  case "$desktop_arch:$artifact" in
    x64:*x86_64* | x64:*-x64.* | arm64:*aarch64* | arm64:*arm64.*) arch_artifacts+=("$artifact") ;;
  esac
done
if [[ ${#arch_artifacts[@]} -eq 0 ]]; then
  echo "No $desktop_arch AppImage found in $repo_dir/release (have: ${built_artifacts[*]})" >&2
  exit 1
fi
appimage_src="$(ls -t "${arch_artifacts[@]}" | head -n1)"

applications_dir="$HOME/Applications"
appimage_path="$applications_dir/T3-Code.AppImage"
mkdir -p "$applications_dir"
# Copy-then-move so an interrupted run never leaves a truncated AppImage.
appimage_tmp="$(mktemp "$applications_dir/.T3-Code.AppImage.XXXXXX")"
cp "$appimage_src" "$appimage_tmp"
chmod +x "$appimage_tmp"

# AppImages register no launcher entry of their own (the app only writes a
# NoDisplay url-handler), so maintain one for the desktop launcher menu.
desktop_entry_dir="$HOME/.local/share/applications"
icon_dir="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$desktop_entry_dir" "$icon_dir"
icon_path="$icon_dir/t3code.png"
icon_tmp="$(mktemp "$icon_dir/.t3code.XXXXXX.png")"
magick "$repo_dir/assets/prod/black-universal-1024.png" -resize 512x512 "$icon_tmp"
desktop_entry_path="$desktop_entry_dir/t3code.desktop"
desktop_entry_tmp="$(mktemp "$desktop_entry_dir/.t3code.XXXXXX.desktop")"
cat >"$desktop_entry_tmp" <<DESKTOP
[Desktop Entry]
Type=Application
Name=T3 Code
Comment=Open-source control plane for coding agents
Exec=$applications_dir/T3-Code.AppImage %U
TryExec=$applications_dir/T3-Code.AppImage
Icon=t3code
Terminal=false
StartupWMClass=t3code
Categories=Development;
MimeType=x-scheme-handler/t3code;
StartupNotify=true
DESKTOP

node_path="$(node -p 'process.execPath')"
server_entry="$repo_dir/apps/server/dist/bin.mjs"
if [[ ! -f "$server_entry" ]]; then
  echo "Headless server entry missing after build: $server_entry" >&2
  exit 1
fi
install_user_t3_shim "$server_entry"
bash "$repo_dir/scripts/install-user-agent-skill.sh" \
  "$repo_dir/apps/server/resources/skills/manage-t3-threads" \
  "$HOME"
launcher_log="$HOME/.t3/userdata/logs/boot-service.log"
# HTTPS port already published on this tailnet. The server tears the old
# mapping down on stop and points it at the new listen port on start, so
# paired clients keep the same MagicDNS URL across service restarts.
tailscale_serve_port=8443
unit_tmp="$(mktemp "$unit_dir/.t3code.service.XXXXXX")"

cleanup() {
  local staged_path
  for staged_path in "$unit_tmp" "$appimage_tmp" "$desktop_entry_tmp" "$icon_tmp"; do
    if [[ -n "$staged_path" ]]; then rm -f "$staged_path"; fi
  done
}
trap cleanup EXIT

cat >"$unit_tmp" <<UNIT
[Unit]
Description=T3 Code server (netpro2k fork)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=T3CODE_HOME=$HOME/.t3
ExecStart=$node_path $server_entry serve --tailscale-serve --tailscale-serve-port $tailscale_serve_port
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
StandardOutput=append:$launcher_log
StandardError=append:$launcher_log

[Install]
WantedBy=default.target
UNIT

# Hand the cutover to a transient unit before stopping the service. A provider
# running inside t3code.service may be executing this script, so the original
# shell cannot be responsible for bringing that same service back.
handoff_unit="t3code-fork-update-$(date +%s)-$$"
handoff_appimage_tmp=$appimage_tmp
handoff_desktop_entry_tmp=$desktop_entry_tmp
handoff_icon_tmp=$icon_tmp
handoff_unit_tmp=$unit_tmp
appimage_tmp=""
desktop_entry_tmp=""
icon_tmp=""
unit_tmp=""
if ! systemd-run --user --collect --property=Type=exec --unit="$handoff_unit" \
  bash "$repo_dir/scripts/complete-linux-update.sh" \
  "$repo_dir" "$node_path" "$server_entry" \
  "$handoff_appimage_tmp" "$appimage_path" \
  "$handoff_desktop_entry_tmp" "$desktop_entry_path" \
  "$handoff_icon_tmp" "$icon_path" "$handoff_unit_tmp"; then
  rm -f "$handoff_appimage_tmp" "$handoff_desktop_entry_tmp" "$handoff_icon_tmp" "$handoff_unit_tmp"
  exit 1
fi

# The transient service now owns all staged files.
trap - EXIT

echo "Staged T3 Code $release_version fork commit $(git rev-parse --short HEAD) from $repo_dir"
echo "Cutover continues in user service $handoff_unit; the current T3 thread may disconnect briefly."
echo "Follow it with: journalctl --user -fu $handoff_unit"
