#!/usr/bin/env bash

# Installs one tracked Agent Skill into the user-wide Codex and Claude roots.
# Grok Build discovers both roots and deduplicates skills by name.

set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 SOURCE_SKILL_DIR USER_HOME" >&2
  exit 2
fi

source_skill_dir=${1%/}
user_home=${2%/}

if [[ "$source_skill_dir" != /* || ! -d "$source_skill_dir" ]]; then
  echo "Skill source must be an existing absolute directory: $source_skill_dir" >&2
  exit 1
fi
if [[ ! -f "$source_skill_dir/SKILL.md" ]]; then
  echo "Skill source is missing SKILL.md: $source_skill_dir" >&2
  exit 1
fi
if [[ -n "$(find "$source_skill_dir" -type l -print -quit)" ]]; then
  echo "Refusing to install a skill containing symlinks: $source_skill_dir" >&2
  exit 1
fi
if [[ "$user_home" != /* || "$user_home" == "/" || ! -d "$user_home" ]]; then
  echo "User home must be an existing absolute directory other than /: $user_home" >&2
  exit 1
fi

skill_name=${source_skill_dir##*/}
if [[ ! "$skill_name" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ ]]; then
  echo "Invalid skill directory name: $skill_name" >&2
  exit 1
fi

destination_roots=(
  "$user_home/.agents/skills"
  "$user_home/.claude/skills"
)

preflight_directory() {
  local directory=$1

  if [[ -L "$directory" && ! -d "$directory" ]]; then
    echo "Refusing to use dangling directory symlink: $directory" >&2
    return 1
  fi
  if [[ -e "$directory" && ! -d "$directory" ]]; then
    echo "Refusing to replace non-directory path: $directory" >&2
    return 1
  fi
}

preflight_destination() {
  local destination_root=$1
  local destination="$destination_root/$skill_name"
  local source_path
  local relative_path
  local destination_path

  preflight_directory "${destination_root%/skills}"
  preflight_directory "$destination_root"

  if [[ -L "$destination" ]]; then
    echo "Refusing to replace symlinked skill directory: $destination" >&2
    return 1
  fi
  preflight_directory "$destination"

  while IFS= read -r -d '' source_path; do
    relative_path=${source_path#"$source_skill_dir"}
    destination_path="$destination$relative_path"
    if [[ -L "$destination_path" ]]; then
      echo "Refusing to replace symlinked skill directory: $destination_path" >&2
      return 1
    fi
    preflight_directory "$destination_path"
  done < <(find "$source_skill_dir" -mindepth 1 -type d -print0)

  while IFS= read -r -d '' source_path; do
    relative_path=${source_path#"$source_skill_dir"}
    destination_path="$destination$relative_path"
    if [[ -L "$destination_path" || ( -e "$destination_path" && ! -f "$destination_path" ) ]]; then
      echo "Refusing to replace non-file skill path: $destination_path" >&2
      return 1
    fi
  done < <(find "$source_skill_dir" -type f -print0)
}

install_destination() {
  local destination_root=$1
  local destination="$destination_root/$skill_name"
  local source_path
  local relative_path
  local destination_path
  local destination_dir
  local staged_path

  mkdir -p "$destination"
  while IFS= read -r -d '' source_path; do
    relative_path=${source_path#"$source_skill_dir"}
    destination_path="$destination$relative_path"
    destination_dir=${destination_path%/*}
    mkdir -p "$destination_dir"
    staged_path="$(mktemp "$destination_dir/.${skill_name}.XXXXXX")"
    if ! cp -p "$source_path" "$staged_path"; then
      rm -f "$staged_path"
      return 1
    fi
    if ! mv -f "$staged_path" "$destination_path"; then
      rm -f "$staged_path"
      return 1
    fi
  done < <(find "$source_skill_dir" -type f -print0)

  echo "Installed $skill_name at $destination"
}

# Validate both roots before writing either one, so an invalid provider path
# cannot leave only half of the requested user-wide installation updated.
for destination_root in "${destination_roots[@]}"; do
  preflight_destination "$destination_root"
done
for destination_root in "${destination_roots[@]}"; do
  install_destination "$destination_root"
done
