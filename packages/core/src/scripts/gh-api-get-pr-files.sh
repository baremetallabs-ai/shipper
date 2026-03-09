#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "Usage: gh-api-get-pr-files.sh <owner/repo> <pr-number>" >&2; exit 1; }
exec gh api "repos/$1/pulls/$2/files" --jq '.[] | {filename, status, additions, deletions, patch}'
