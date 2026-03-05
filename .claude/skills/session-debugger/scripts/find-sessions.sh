#!/usr/bin/env bash
# Find Claude Code session transcripts for a given GitHub issue number.
# Usage: find-sessions.sh <issue-number>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: find-sessions.sh <issue-number>" >&2
  exit 1
fi

ISSUE_NUM="$1"
PROJECTS_DIR="$HOME/.claude/projects"

if [[ ! -d "$PROJECTS_DIR" ]]; then
  echo "Error: $PROJECTS_DIR does not exist" >&2
  exit 1
fi

# Derive repo name from git remote
REPO_NAME=""
if remote_url=$(git remote get-url origin 2>/dev/null); then
  REPO_NAME=$(basename "$remote_url" .git)
fi

if [[ -z "$REPO_NAME" ]]; then
  echo "Error: could not determine repo name from git remote" >&2
  exit 1
fi

# Collect matching project directories
matching_dirs=()

for dir in "$PROJECTS_DIR"/*/; do
  [[ -d "$dir" ]] || continue
  dirname=$(basename "$dir")

  # Match worktree directories containing the repo name and issue number
  # Pattern: *shipper-worktrees-<repo>--wt--*<N>-* or *shipper-<N>-*
  if [[ "$dirname" == *"$REPO_NAME"* ]]; then
    # Check if directory name contains the issue number in a branch-like pattern
    # e.g., shipper-42-some-slug or just contains -42- in worktree name
    if [[ "$dirname" =~ (shipper-|--wt--).*(-|/)${ISSUE_NUM}(-|$) ]] ||
       [[ "$dirname" =~ [-/]${ISSUE_NUM}[-/] ]]; then
      matching_dirs+=("$dir")
    fi
  fi
done

# Also check the main repo project directory
for dir in "$PROJECTS_DIR"/*/; do
  dirname=$(basename "$dir")
  if [[ "$dirname" == *"repos-$REPO_NAME" ]] || [[ "$dirname" == *"repos-$REPO_NAME-"* ]]; then
    # Only add if not already in the list
    already_added=false
    for existing in "${matching_dirs[@]+"${matching_dirs[@]}"}"; do
      if [[ "$existing" == "$dir" ]]; then
        already_added=true
        break
      fi
    done
    if [[ "$already_added" == false ]]; then
      matching_dirs+=("$dir")
    fi
  fi
done

if [[ ${#matching_dirs[@]} -eq 0 ]]; then
  echo "No project directories found for repo '$REPO_NAME' issue #$ISSUE_NUM" >&2
  exit 1
fi

# List all JSONL files (excluding subagents/) sorted by mtime descending
output=""
for dir in "${matching_dirs[@]}"; do
  while IFS= read -r -d '' file; do
    mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$file" 2>/dev/null || stat -c '%y' "$file" 2>/dev/null | cut -d. -f1)
    output+="$mtime  $file"$'\n'
  done < <(find "$dir" -maxdepth 1 -name '*.jsonl' -print0 2>/dev/null)
done

if [[ -z "$output" ]]; then
  echo "No JSONL session files found in matched directories" >&2
  exit 1
fi

echo "$output" | sort -r
