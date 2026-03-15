#!/usr/bin/env bash
# Find Claude Code and Codex CLI session transcripts for a given GitHub issue number.
# Usage: find-sessions.sh <issue-number>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: find-sessions.sh <issue-number>" >&2
  exit 1
fi

ISSUE_NUM="$1"
SHIPPER_SESSIONS_DIR="$HOME/.shipper/sessions"
PROJECTS_DIR="$HOME/.claude/projects"
CODEX_DIR="$HOME/.codex/sessions"
MATCH_BYTES=40000

if ! [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]]; then
  echo "Error: issue number must be numeric" >&2
  exit 1
fi

# Derive repo name from git remote
REPO_FULL=""
REPO_NAME=""
REPO_SLUG=""

parse_remote_repo() {
  local remote="$1"
  local path_part

  if [[ "$remote" == *"://"* ]]; then
    path_part="${remote#*://}"
    path_part="${path_part#*/}"
  elif [[ "$remote" == *":"* ]]; then
    path_part="${remote#*:}"
  else
    path_part="$remote"
  fi

  path_part="${path_part%.git}"
  if [[ "$path_part" == */* ]]; then
    echo "$path_part" | awk -F/ '{print $(NF-1) "/" $NF}'
    return
  fi
}

if remote_url=$(git remote get-url origin 2>/dev/null); then
  REPO_FULL=$(parse_remote_repo "$remote_url")
  if [[ -n "$REPO_FULL" ]]; then
    REPO_NAME="${REPO_FULL##*/}"
    REPO_SLUG="${REPO_FULL/\//-}"
  else
    REPO_NAME=$(basename "$remote_url" .git)
    REPO_SLUG="$REPO_NAME"
  fi
fi

if [[ ! -d "$SHIPPER_SESSIONS_DIR" ]] && [[ ! -d "$PROJECTS_DIR" ]] && [[ ! -d "$CODEX_DIR" ]]; then
  echo "Error: none of $SHIPPER_SESSIONS_DIR, $PROJECTS_DIR, or $CODEX_DIR exists" >&2
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
  [[ "$path" =~ (shipper-|--wt--).*(-|/)${ISSUE_NUM}(-|$) ]]
}

is_repo_path() {
  local path="$1"
  [[ -n "$REPO_NAME" ]] && [[ "$path" == *"$REPO_NAME"* ]]
}

append_result() {
  local agent="$1"
  local file="$2"
  local mtime_source="${3:-$file}"
  local mtime

  mtime=$(get_mtime "$mtime_source")
  [[ -n "$mtime" ]] || return 0

  results+=("[$agent]  $mtime  $file")
}

collect_shipper_sessions() {
  local dir
  local meta
  local meta_issue
  local meta_agent
  local log_file
  local search_dirs=()

  if [[ -n "$REPO_SLUG" ]]; then
    search_dirs+=("$SHIPPER_SESSIONS_DIR/$REPO_SLUG")
  fi
  search_dirs+=("$SHIPPER_SESSIONS_DIR/_unlinked")

  for dir in "${search_dirs[@]}"; do
    [[ -d "$dir" ]] || continue

    while IFS= read -r -d '' meta; do
      meta_issue=$(jq -r '.issue // ""' "$meta" 2>/dev/null || true)
      [[ "$meta_issue" == "$ISSUE_NUM" ]] || continue

      log_file=$(jq -r '.logFile // ""' "$meta" 2>/dev/null || true)
      meta_agent=$(jq -r '.agent // "unknown"' "$meta" 2>/dev/null || true)
      [[ -n "$log_file" ]] || continue
      [[ -f "$log_file" ]] || continue

      append_result "$meta_agent" "$log_file" "$meta"
    done < <(find "$dir" -maxdepth 1 -type f -name '*.meta.json' -print0 2>/dev/null)
  done
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
  [[ -n "$REPO_NAME" ]] || return 0

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
  [[ -n "$REPO_NAME" ]] || return 0

  while IFS= read -r -d '' file; do
    cwd=$(head -n 1 "$file" | jq -r 'select(.type == "session_meta") | .payload.cwd // ""' 2>/dev/null || true)

    if [[ -n "$cwd" ]] && is_repo_path "$cwd" && is_issue_worktree_path "$cwd"; then
      append_result "codex" "$file"
      continue
    fi

    if [[ -n "$cwd" ]] && is_repo_path "$cwd" && head -c "$MATCH_BYTES" "$file" | grep -qE "$issue_pattern" 2>/dev/null; then
      append_result "codex" "$file"
    fi
  done < <(find "$CODEX_DIR" -type f -name '*.jsonl' -print0 2>/dev/null)
}

collect_shipper_sessions
collect_claude_sessions
collect_codex_sessions

if [[ ${#results[@]} -eq 0 ]]; then
  repo_label="${REPO_FULL:-${REPO_NAME:-_unlinked}}"
  echo "No session files found for repo '$repo_label' issue #$ISSUE_NUM" >&2
  exit 1
fi

printf '%s\n' "${results[@]}" | sort -k2,2nr -k3,3
