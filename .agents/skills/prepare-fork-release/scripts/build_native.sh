#!/usr/bin/env bash
set -euo pipefail
version=${1:?Pass the fork version}
commit=${2:?Pass the exact candidate commit}
[[ $# == 2 && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-netpro2k(\.[1-9][0-9]*)?$ && "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
repo=$(git rev-parse --show-toplevel)
common=$(git rev-parse --path-format=absolute --git-common-dir)
primary=$(dirname "$common")
output="$(dirname "$primary")/t3-releases/$version"
node_version=$(git show "$commit:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["engines"]["node"])')
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
node="$HOME/.local/share/mise/installs/node/$node_version/bin/node"
if [[ ! -x "$node" ]]; then mise install "node@$node_version"; fi
[[ -x "$node" ]] || { echo "Pinned Node is unavailable: $node" >&2; exit 1; }
export PATH="$(dirname "$node"):$PATH"
cd "$repo"
mkdir -p "$output"
if [[ -e "$output/linux-x64" ]]; then
  "$node" scripts/fork-release.ts validate --version "$version" --dir "$output" --targets linux-x64
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["commit"] == sys.argv[2]' "$output/linux-x64/build.json" "$commit"
else
  "$node" --input-type=module - "$primary" "$version" "$commit" "$output" <<'JS'
import { loadRepoEnv } from './scripts/lib/public-config.ts';
import { spawnSync } from 'node:child_process';
const [primary,version,commit,output] = process.argv.slice(2);
const source = loadRepoEnv({repoRoot: primary});
const keys = ['T3CODE_CLERK_PUBLISHABLE_KEY','T3CODE_CLERK_JWT_TEMPLATE','T3CODE_CLERK_CLI_OAUTH_CLIENT_ID','T3CODE_RELAY_URL'];
const env = {...process.env,...Object.fromEntries(keys.map(key => [key,source[key] ?? '']))};
const result = spawnSync(process.execPath,['scripts/fork-release.ts','build','--version',version,'--ref',commit,'--dir',output],{stdio:'inherit',env});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
JS
fi
ssh -o BatchMode=yes -o ConnectTimeout=10 -o HostKeyAlias=studio.local studio "bash -s -- $version $commit $node_version" <<'MAC'
set -euo pipefail
version=$1 commit=$2 node_version=$3
source_root="$HOME/Code/t3code"
output="$HOME/Code/t3-releases/$version"
node="$HOME/.local/share/mise/installs/node/$node_version/bin/node"
export PATH="$(dirname "$node"):$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ ! -x "$node" ]]; then mise install "node@$node_version"; fi
[[ -x "$node" ]] || exit 1
git -C "$source_root" fetch origin '+refs/heads/*:refs/remotes/origin/*'
git -C "$source_root" fetch upstream tag "v${version%%-*}"
dispatcher="$HOME/Code/.t3-dispatch-${commit:0:12}"
git -C "$source_root" worktree add --detach "$dispatcher" "$commit"
cleanup() { git -C "$source_root" worktree remove --force "$dispatcher"; }
trap cleanup EXIT
cd "$dispatcher"
vp install --frozen-lockfile
source "$HOME/.config/t3code/signing/environment.sh"
if [[ -e "$output/darwin-arm64" ]]; then
  "$node" scripts/fork-release.ts validate --version "$version" --dir "$output" --targets darwin-arm64
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["commit"] == sys.argv[2]' "$output/darwin-arm64/build.json" "$commit"
else
  "$node" --input-type=module - "$source_root" "$version" "$commit" "$output" <<'JS'
import { loadRepoEnv } from './scripts/lib/public-config.ts';
import { spawnSync } from 'node:child_process';
const [primary,version,commit,output] = process.argv.slice(2);
const source = loadRepoEnv({repoRoot: primary});
const keys = ['T3CODE_CLERK_PUBLISHABLE_KEY','T3CODE_CLERK_JWT_TEMPLATE','T3CODE_CLERK_CLI_OAUTH_CLIENT_ID','T3CODE_RELAY_URL'];
const env = {...process.env,...Object.fromEntries(keys.map(key => [key,source[key] ?? '']))};
const result = spawnSync(process.execPath,['scripts/fork-release.ts','build','--version',version,'--ref',commit,'--dir',output],{stdio:'inherit',env});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
JS
fi
MAC
if [[ ! -e "$output/darwin-arm64" ]]; then
  transfer=$(mktemp -d "$output/.mac-transfer.XXXXXX")
  scp -q -r -o BatchMode=yes -o HostKeyAlias=studio.local "studio:Code/t3-releases/$version/darwin-arm64" "$transfer/"
  mv "$transfer/darwin-arm64" "$output/darwin-arm64"
  rmdir "$transfer"
fi
"$node" scripts/fork-release.ts validate --version "$version" --dir "$output"
