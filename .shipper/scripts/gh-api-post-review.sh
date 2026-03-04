#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]] || { echo "Usage: gh-api-post-review.sh <owner/repo> <pr-number> <payload-file>" >&2; exit 1; }
[[ -f "$3" ]] || { echo "Error: Payload file '$3' not found" >&2; exit 1; }
exec gh api "repos/$1/pulls/$2/reviews" --method POST --input "$3"
