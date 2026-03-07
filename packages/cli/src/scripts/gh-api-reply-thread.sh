#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 4 ]] || { echo "Usage: gh-api-reply-thread.sh <owner/repo> <pr-number> <comment-id> <body>" >&2; exit 1; }
exec gh api "repos/$1/pulls/$2/comments/$3/replies" --method POST -f body="$4"
