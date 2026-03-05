#!/usr/bin/env bash
# Show the full result of a specific tool call by index number.
# Usage: show-tool-result.sh <jsonl-file-path> <tool-call-number>
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: show-tool-result.sh <jsonl-file-path> <tool-call-number>" >&2
  exit 1
fi

FILE="$1"
TOOL_NUM="$2"

if [[ ! -f "$FILE" ]]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 1
fi

# Extract the Nth tool_use block (1-indexed)
tool_use=$(jq -c '
  select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  {id, name, input}
' "$FILE" 2>/dev/null | sed -n "${TOOL_NUM}p")

if [[ -z "$tool_use" ]]; then
  echo "Error: tool call #$TOOL_NUM not found (out of range)" >&2
  exit 1
fi

tool_id=$(echo "$tool_use" | jq -r '.id')
tool_name=$(echo "$tool_use" | jq -r '.name')

echo "=== Tool Call #$TOOL_NUM ==="
echo "Name: $tool_name"
echo "ID:   $tool_id"
echo ""
echo "--- Input ---"
echo "$tool_use" | jq '.input'

# Find matching tool_result
tool_result=$(jq -c --arg id "$tool_id" '
  select(.type == "user" and .message.content and (.message.content | type) == "array") |
  .message.content[] |
  select(.type == "tool_result" and .tool_use_id == $id)
' "$FILE" 2>/dev/null | head -1)

echo ""
echo "--- Result ---"

if [[ -z "$tool_result" ]]; then
  echo "(no result found)"
  exit 0
fi

is_error=$(echo "$tool_result" | jq -r '.is_error // false')
echo "is_error: $is_error"
echo ""

# Extract content (handles both string and array formats)
echo "$tool_result" | jq -r '
  if (.content | type) == "string" then
    .content
  elif (.content | type) == "array" then
    [.content[] | select(.type == "text") | .text] | join("\n")
  else
    "(empty)"
  end
'
