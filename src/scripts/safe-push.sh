#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    echo "Error: --force push is not allowed. Use --force-with-lease instead." >&2
    exit 1
  fi
  # Block any short-option cluster containing f (e.g. -f, -fu) but not long options like --force-with-lease
  if [[ "$arg" == -* && "$arg" != --* && "$arg" == *f* ]]; then
    echo "Error: -f (force) push is not allowed. Use --force-with-lease instead." >&2
    exit 1
  fi
  # Block force refspecs starting with "+"
  if [[ "$arg" == +* ]]; then
    echo "Error: Force push refspecs (starting with '+') are not allowed. Use --force-with-lease instead." >&2
    exit 1
  fi
done
exec git push "$@"
