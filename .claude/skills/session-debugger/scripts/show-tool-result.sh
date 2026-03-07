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

if ! [[ "$TOOL_NUM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: tool call number must be a positive integer" >&2
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

if [[ "$agent" == "claude" ]]; then
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

  echo "$tool_result" | jq -r '
    if (.content | type) == "string" then
      .content
    elif (.content | type) == "array" then
      [.content[] | select(.type == "text") | .text] | join("\n")
    else
      "(empty)"
    end
  '

  exit 0
fi

tool_use=$(jq -c '
  def parsed_args:
    if (.payload.arguments | type) == "string" then
      ((.payload.arguments | fromjson?) // .payload.arguments)
    elif (.payload.arguments | type) == "object" then
      .payload.arguments
    else
      {}
    end;

  select(
    .type == "response_item" and
    (.payload.type == "function_call" or .payload.type == "custom_tool_call")
  ) |
  {
    id: .payload.call_id,
    name: .payload.name,
    call_type: .payload.type,
    input: (
      if .payload.type == "function_call" then
        parsed_args
      else
        (.payload.input // "")
      end
    )
  }
' "$FILE" 2>/dev/null | sed -n "${TOOL_NUM}p")

if [[ -z "$tool_use" ]]; then
  echo "Error: tool call #$TOOL_NUM not found (out of range)" >&2
  exit 1
fi

tool_id=$(echo "$tool_use" | jq -r '.id')
tool_name=$(echo "$tool_use" | jq -r '.name')
call_type=$(echo "$tool_use" | jq -r '.call_type')

echo "=== Tool Call #$TOOL_NUM ==="
echo "Name: $tool_name"
echo "ID:   $tool_id"
echo ""
echo "--- Input ---"

if [[ "$call_type" == "function_call" ]]; then
  echo "$tool_use" | jq '.input'
else
  echo "$tool_use" | jq -r '.input'
fi

tool_result=$(jq -c --arg id "$tool_id" '
  select(
    .type == "response_item" and
    (.payload.type == "function_call_output" or .payload.type == "custom_tool_call_output") and
    .payload.call_id == $id
  ) |
  .payload
' "$FILE" 2>/dev/null | head -1)

echo ""
echo "--- Result ---"

if [[ -z "$tool_result" ]]; then
  echo "(no result found)"
  exit 0
fi

echo "$tool_result" | jq -r '
  if (.output | type) == "string" then
    ((.output | fromjson? | .output) // .output)
  else
    (.output // "(empty)")
  end
'
