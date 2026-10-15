#!/bin/bash

# Add common Node.js locations when launched outside an interactive shell.
cd -- "$(dirname -- "$0")" || exit 1
cc98_node=""
for cc98_candidate in "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -x "$cc98_candidate" ] && "$cc98_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    cc98_node="$cc98_candidate"
    break
  fi
done

if [ -z "$cc98_node" ]; then
  echo "Node.js 24 or newer is required: https://nodejs.org"
  exit 1
fi

"$cc98_node" scripts/stop.mjs "$@"
