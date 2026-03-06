#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "Usage: gh-api-get-review-threads.sh <owner/repo> <pr-number>" >&2; exit 1; }
owner="${1%%/*}"
repo="${1##*/}"

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
              author: .author.login,
              body,
              createdAt
            })
        )
      })
  '
