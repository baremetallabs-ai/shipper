#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "Usage: gh-api-get-reviews.sh <owner/repo> <pr-number>" >&2; exit 1; }
exec gh api "repos/$1/pulls/$2/reviews" --paginate
