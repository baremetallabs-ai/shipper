#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "Usage: gh-api-get-review-threads.sh <owner/repo> <pr-number>" >&2; exit 1; }
[[ "$1" == */* ]] || { echo "Usage: gh-api-get-review-threads.sh <owner/repo> <pr-number>" >&2; exit 1; }
owner="${1%%/*}"
repo="${1##*/}"
rest_after_first_slash="${1#*/}"
[[ -n "$owner" && -n "$repo" && "$rest_after_first_slash" != */* ]] || {
  echo "Usage: gh-api-get-review-threads.sh <owner/repo> <pr-number>" >&2
  exit 1
}

exec gh api graphql \
  -f owner="$owner" \
  -f repo="$repo" \
  -F number="$2" \
  -f query='
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              path
              line
              isResolved
              isOutdated
              comments(first: 100) {
                nodes {
                  databaseId
                  author {
                    login
                  }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  ' \
  --jq '
    .data.repository.pullRequest.reviewThreads.nodes
    | map({
        path,
        line,
        isResolved,
        isOutdated,
        comments: (
          .comments.nodes
          | map({
              id: .databaseId,
              author: .author.login,
              body,
              createdAt
            })
        )
      })
  '
