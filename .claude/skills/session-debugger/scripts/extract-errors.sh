#!/usr/bin/env bash
# Extract errors from tool results, including content-level errors not flagged by is_error.
# Usage: extract-errors.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: extract-errors.sh <jsonl-file-path>" >&2
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

# Error patterns to detect in tool result content
ERROR_PATTERN='fatal:|[Ee]rror:|EACCES|ENOENT|EPERM|Permission denied|command not found|No such file|403 Forbidden|404 Not Found|401 Unauthorized|exit code [1-9]|exit status [1-9]|[Ff]ailed to|FAILED|panic:|Traceback|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError'

# Pass 1: Build map of tool_use_id → {is_error, content_snippet}
tool_results_map=$(jq -c '
  select(.type == "user" and .message.content and (.message.content | type) == "array") |
  .message.content[] |
  select(.type == "tool_result") |
  {
    id: .tool_use_id,
    is_error: (.is_error // false),
    content: (
      if (.content | type) == "string" then
        .content[:500]
      elif (.content | type) == "array" then
        ([.content[] | select(.type == "text") | .text] | join("\n"))[:500]
      else
        ""
      end
    )
  }
' "$FILE" 2>/dev/null)

# Build a JSON object keyed by tool_use_id
results_by_id=$(echo "$tool_results_map" | jq -s 'map({(.id): {is_error, content}}) | add // {}')

# Pass 2: Iterate tool_use records, check each result for errors
found_errors=false
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

  # Get input summary
  input_summary=$(echo "$tool" | jq -r '
    if .name == "Bash" then
      (.input.command // "") | .[0:80]
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
      (.input.prompt // "") | .[0:60]
    else
      (.input | tostring) | .[0:60]
    end
  ')

  # Look up result
  result_data=$(echo "$results_by_id" | jq -r --arg id "$tool_id" '.[$id] // empty')
  [[ -n "$result_data" ]] || continue

  is_error=$(echo "$result_data" | jq -r '.is_error')
  content=$(echo "$result_data" | jq -r '.content')

  error_type=""
  if [[ "$is_error" == "true" ]]; then
    error_type="IS_ERROR"
  elif echo "$content" | grep -qE "$ERROR_PATTERN" 2>/dev/null; then
    error_type="CONTENT_ERROR"
  fi

  if [[ -n "$error_type" ]]; then
    found_errors=true
    # Extract first matching error line for context
    error_line=$(echo "$content" | grep -oE ".{0,120}($ERROR_PATTERN).{0,40}" | head -1 || echo "$content" | head -1 | cut -c1-120)
    printf "[%3d] %-12s | %-13s | %s\n" "$index" "$name" "$error_type" "$input_summary"
    printf "      %s\n" "$error_line"
  fi
done

# Check if any output was produced (the while loop runs in a subshell)
if ! jq -c '
  select(.type == "user" and .message.content and (.message.content | type) == "array") |
  .message.content[] |
  select(.type == "tool_result") |
  select(.is_error == true or (
    (if (.content | type) == "string" then .content
     elif (.content | type) == "array" then ([.content[] | select(.type == "text") | .text] | join("\n"))
     else "" end) |
    test("fatal:|[Ee]rror:|EACCES|ENOENT|EPERM|Permission denied|command not found|No such file|403 Forbidden|404 Not Found|401 Unauthorized|exit code [1-9]|exit status [1-9]|[Ff]ailed to|FAILED|panic:|Traceback|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError")
  ))
' "$FILE" 2>/dev/null | head -1 | grep -q .; then
  echo "No errors found."
fi
