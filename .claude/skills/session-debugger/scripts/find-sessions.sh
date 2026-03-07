#!/usr/bin/env bash
# Find Claude Code and Codex CLI session transcripts for a given GitHub issue number.
# Usage: find-sessions.sh <issue-number>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: find-sessions.sh <issue-number>" >&2
  exit 1
fi

ISSUE_NUM="$1"
PROJECTS_DIR="$HOME/.claude/projects"
CODEX_DIR="$HOME/.codex/sessions"
MATCH_BYTES=40000

if ! [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]]; then
  echo "Error: issue number must be numeric" >&2
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

if [[ ! -d "$PROJECTS_DIR" ]] && [[ ! -d "$CODEX_DIR" ]]; then
  echo "Error: neither $PROJECTS_DIR nor $CODEX_DIR exists" >&2
  exit 1
fi

issue_pattern="(# Issue #${ISSUE_NUM}:|Issue #${ISSUE_NUM}([^0-9]|$)|shipper/${ISSUE_NUM}-|issues/${ISSUE_NUM}([^0-9]|$)|#${ISSUE_NUM}([^0-9]|$))"
results=()

get_mtime() {
  local file="$1"
  stat -f '%m' "$file" 2>/dev/null || stat -c '%Y' "$file" 2>/dev/null
}

is_issue_worktree_path() {
  local path="$1"
  [[ "$path" =~ (shipper-|--wt--).*(-|/)${ISSUE_NUM}(-|$) ]] || [[ "$path" =~ (^|[-/])${ISSUE_NUM}([-/.]|$) ]]
}

append_result() {
  local agent="$1"
  local file="$2"
  local mtime

  mtime=$(get_mtime "$file")
  [[ -n "$mtime" ]] || return 0

  results+=("[$agent]  $mtime  $file")
}

collect_claude_sessions() {
  local matching_dirs=()
  local main_repo_dirs=()
  local dir
  local dirname
  local file
  local already_added
  local existing

  [[ -d "$PROJECTS_DIR" ]] || return 0

  for dir in "$PROJECTS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    dirname=$(basename "$dir")

    if [[ "$dirname" == *"$REPO_NAME"* ]]; then
      if is_issue_worktree_path "$dirname"; then
        matching_dirs+=("$dir")
      fi
    fi
  done

  for dir in "$PROJECTS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    dirname=$(basename "$dir")

    if [[ "$dirname" == *"repos-$REPO_NAME" ]] || [[ "$dirname" == *"repos-$REPO_NAME-"* ]]; then
      already_added=false
      for existing in "${matching_dirs[@]+"${matching_dirs[@]}"}"; do
        if [[ "$existing" == "$dir" ]]; then
          already_added=true
          break
        fi
      done

      if [[ "$already_added" == false ]]; then
        main_repo_dirs+=("$dir")
      fi
    fi
  done

  for dir in "${matching_dirs[@]+"${matching_dirs[@]}"}"; do
    [[ -n "$dir" ]] || continue
    while IFS= read -r -d '' file; do
      append_result "claude" "$file"
    done < <(find "$dir" -maxdepth 1 -name '*.jsonl' -print0 2>/dev/null)
  done

  for dir in "${main_repo_dirs[@]+"${main_repo_dirs[@]}"}"; do
    [[ -n "$dir" ]] || continue
    while IFS= read -r -d '' file; do
      if head -c "$MATCH_BYTES" "$file" | grep -qE "$issue_pattern" 2>/dev/null; then
        append_result "claude" "$file"
      fi
    done < <(find "$dir" -maxdepth 1 -name '*.jsonl' -print0 2>/dev/null)
  done
}

collect_codex_sessions() {
  local file
  local cwd

  [[ -d "$CODEX_DIR" ]] || return 0

  while IFS= read -r -d '' file; do
    cwd=$(head -n 1 "$file" | jq -r 'select(.type == "session_meta") | .payload.cwd // ""' 2>/dev/null || true)

    if [[ -n "$cwd" ]] && is_issue_worktree_path "$cwd"; then
      append_result "codex" "$file"
      continue
    fi

    if head -c "$MATCH_BYTES" "$file" | grep -qE "$issue_pattern" 2>/dev/null; then
      append_result "codex" "$file"
    fi
  done < <(find "$CODEX_DIR" -type f -name '*.jsonl' -print0 2>/dev/null)
}

collect_claude_sessions
collect_codex_sessions

if [[ ${#results[@]} -eq 0 ]]; then
  echo "No session files found for repo '$REPO_NAME' issue #$ISSUE_NUM" >&2
  exit 1
fi

printf '%s\n' "${results[@]}" | sort -k2,2nr -k3,3
