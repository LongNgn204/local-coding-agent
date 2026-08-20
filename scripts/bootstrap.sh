#!/usr/bin/env bash
# Local Coding Agent bootstrap for macOS/Linux.
set -euo pipefail

repository="https://github.com/LongNgn204/local-coding-agent.git"
install_dir="${LCA_INSTALL_DIR:-${HOME}/local-coding-agent}"

command -v git >/dev/null 2>&1 || {
  echo "Git is required. Install it with your OS package manager." >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Node.js 18 or newer is required: https://nodejs.org" >&2
  exit 1
}
node_major="$(node -p "process.versions.node.split('.')[0]")"
if (( node_major < 18 )); then
  echo "Node.js 18 or newer is required. Current version: $(node -v)" >&2
  exit 1
fi

if [[ ! -e "$install_dir" ]]; then
  echo "Cloning Local Coding Agent to $install_dir"
  git clone --depth 1 "$repository" "$install_dir"
elif [[ ! -d "$install_dir/.git" ]]; then
  echo "Install path already exists and is not a git clone: $install_dir" >&2
  exit 1
else
  echo "Using existing clone at $install_dir"
fi

cd "$install_dir"
node scripts/local-coding-agent.mjs install
if [[ -r /dev/tty ]]; then
  node scripts/local-coding-agent.mjs setup </dev/tty
else
  echo "Run the interactive setup next: cd '$install_dir' && bash scripts/lca setup"
fi
echo "Setup saved. Start with: cd '$install_dir' && bash scripts/lca start --background"
