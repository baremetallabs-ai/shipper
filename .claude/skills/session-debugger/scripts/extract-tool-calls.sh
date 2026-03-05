#!/usr/bin/env bash
# Extract all tool calls from a Claude Code session transcript.
# Usage: extract-tool-calls.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: extract-tool-calls.sh <jsonl-file-path>" >&2
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

# Build a lookup of tool_use_id -> is_error from tool_result records
# Then extract tool_use blocks from assistant records in order
jq -r '
  # We process the whole file in slurp mode to correlate tool_use with tool_result
  ' /dev/null >/dev/null 2>&1 || true

# Two-pass approach:
# Pass 1: collect tool results (is_error status) keyed by tool_use_id
# Pass 2: collect tool uses in order, look up result status

# Extract tool results into a temp associative structure
tool_results_json=$(jq -c '
  select(.type == "user" and .message.content and (.message.content | type) == "array") |
  .message.content[] |
  select(.type == "tool_result") |
  {(.tool_use_id): .is_error}
' "$FILE" 2>/dev/null | jq -s 'add // {}')

# Extract tool uses in order with their details
index=0
jq -c '
  select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  {id, name, input}
' "$FILE" 2>/dev/null | while IFS= read -r tool; do
  index=$((index + 1))
  name=$(echo "$tool" | jq -r '.name')
  tool_id=$(echo "$tool" | jq -r '.id')

  # Get the key input field based on tool name
  input_summary=$(echo "$tool" | jq -r '
    if .name == "Bash" then
      (.input.command // "") | .[0:100]
    elif .name == "Read" then
      .input.file_path // ""
    elif .name == "Write" then
      .input.file_path // ""
    elif .name == "Edit" then
      .input.file_path // ""
    elif .name == "Glob" then
      .input.pattern // ""
    elif .name == "Grep" then
      .input.pattern // ""
    elif .name == "Task" then
      (.input.prompt // "") | .[0:80]
    elif .name == "WebFetch" then
      .input.url // ""
    elif .name == "WebSearch" then
      .input.query // ""
    else
      (.input | tostring) | .[0:80]
    end
  ')

  # Look up error status
  is_error=$(echo "$tool_results_json" | jq -r --arg id "$tool_id" '.[$id] // false')
  if [[ "$is_error" == "true" ]]; then
    status="ERROR"
  else
    status="OK"
  fi

  printf "[%3d] %-12s | %-100s | %s\n" "$index" "$name" "$input_summary" "$status"
done
