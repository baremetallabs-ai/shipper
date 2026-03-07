#!/usr/bin/env bash
# Extract verdict, label changes, and comments from a Claude Code or Codex CLI session transcript.
# Usage: extract-verdict.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: extract-verdict.sh <jsonl-file-path>" >&2
  exit 1
fi

FILE="$1"

if [[ ! -f "$FILE" ]]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 1
fi

detect_agent() {
  local first_type

  first_type=$(head -n 1 "$1" | jq -r '.type // ""' 2>/dev/null)
  if [[ "$first_type" == "session_meta" ]]; then
    echo "codex"
  else
    echo "claude"
  fi
}

agent=$(detect_agent "$FILE")

echo "=== Verdict ==="

if [[ "$agent" == "claude" ]]; then
  verdict=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(type == "object" and .type == "text") |
    .text
  ' "$FILE" 2>/dev/null | grep -oE '\b(READY|RETRY|NEEDS UPSTREAM)\b' | head -1 || true)

  if [[ -n "$verdict" ]]; then
    echo "Verdict: $verdict"
  else
    echo "Verdict: none found"
  fi

  echo ""
  echo "=== Label Changes ==="

  label_changes=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use" and .name == "Bash") |
    .input.command // "" |
    select(test("gh issue edit.*--add-label|gh issue edit.*--remove-label"))
  ' "$FILE" 2>/dev/null || true)

  if [[ -n "$label_changes" ]]; then
    echo "$label_changes"
  else
    echo "No label changes found"
  fi

  echo ""
  echo "=== Comments Posted ==="

  comments=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use" and .name == "Bash") |
    .input.command // "" |
    select(test("gh (issue|pr) comment"))
  ' "$FILE" 2>/dev/null || true)

  if [[ -n "$comments" ]]; then
    echo "$comments"
  else
    echo "No comments found"
  fi

  exit 0
fi

verdict=$(jq -r '
  select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") |
  [.payload.content[]? | select(.type == "output_text") | .text] | join("\n")
' "$FILE" 2>/dev/null | grep -oE '\b(READY|RETRY|NEEDS UPSTREAM)\b' | head -1 || true)

if [[ -n "$verdict" ]]; then
  echo "Verdict: $verdict"
else
  echo "Verdict: none found"
fi

echo ""
echo "=== Label Changes ==="

commands=$(jq -r '
  def parsed_args:
    if (.payload.arguments | type) == "string" then
      ((.payload.arguments | fromjson?) // {})
    elif (.payload.arguments | type) == "object" then
      .payload.arguments
    else
      {}
    end;

  select(.type == "response_item" and .payload.type == "function_call") |
  (parsed_args.cmd // "")
' "$FILE" 2>/dev/null || true)

label_changes=$(printf '%s\n' "$commands" | grep -E 'gh issue edit.*(--add-label|--remove-label)' || true)

if [[ -n "$label_changes" ]]; then
  echo "$label_changes"
else
  echo "No label changes found"
fi

echo ""
echo "=== Comments Posted ==="

comments=$(printf '%s\n' "$commands" | grep -E 'gh (issue|pr) comment' || true)

if [[ -n "$comments" ]]; then
  echo "$comments"
else
  echo "No comments found"
fi
