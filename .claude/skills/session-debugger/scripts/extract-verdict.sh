#!/usr/bin/env bash
# Extract verdict, label changes, and comments from a Claude Code session transcript.
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

echo "=== Verdict ==="

# Scan assistant text content for verdict keywords
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

# Find gh issue edit calls that modify labels
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

# Find gh issue comment and gh pr comment calls
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
