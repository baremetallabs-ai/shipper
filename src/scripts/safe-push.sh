#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "--force" || "$arg" == "-f" ]]; then
    echo "Error: --force/-f push is not allowed. Use --force-with-lease instead." >&2
    exit 1
  fi
done
exec git push "$@"
