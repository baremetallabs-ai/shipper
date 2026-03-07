#!/usr/bin/env bash
# Extract all tool calls from a Claude Code or Codex CLI session transcript.
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

detect_agent() {
  local first_type

  first_type=$(head -n 1 "$1" | jq -r '.type // ""' 2>/dev/null)
  if [[ "$first_type" == "session_meta" ]]; then
    echo "codex"
  else
    echo "claude"
  fi
}

is_codex_error_output() {
  local output="$1"
  local cleaned

  cleaned=$(printf '%s\n' "$output" | grep -vE '^/opt/homebrew/.*/bin/ps: Operation not permitted$' || true)
  if printf '%s\n' "$cleaned" | grep -qE '^(Process exited with code [1-9]|Exit code: [1-9]|error:|fatal:|Traceback|panic:)' 2>/dev/null; then
    return 0
  fi

  if printf '%s\n' "$cleaned" | grep -qE 'command not found|403 Forbidden|404 Not Found|401 Unauthorized|could not lock config file|unable to write upstream branch configuration|cannot lock ref|cannot create temp file for here document|sandbox.*denied|not allowed in sandbox|execution not permitted|unable to create .+\.lock' 2>/dev/null; then
    return 0
  fi

  return 1
}

agent=$(detect_agent "$FILE")

if [[ "$agent" == "claude" ]]; then
  tool_results_json=$(jq -c '
    select(.type == "user" and .message.content and (.message.content | type) == "array") |
    .message.content[] |
    select(.type == "tool_result") |
    {(.tool_use_id): .is_error}
  ' "$FILE" 2>/dev/null | jq -s 'add // {}')

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

    is_error=$(echo "$tool_results_json" | jq -r --arg id "$tool_id" '.[$id] // false')
    if [[ "$is_error" == "true" ]]; then
      status="ERROR"
    else
      status="OK"
    fi

    printf "[%3d] %-12s | %-100s | %s\n" "$index" "$name" "$input_summary" "$status"
  done

  exit 0
fi

tool_results_json=$(jq -c '
  select(
    .type == "response_item" and
    (.payload.type == "function_call_output" or .payload.type == "custom_tool_call_output")
  ) |
  {(.payload.call_id): (.payload.output // "")}
' "$FILE" 2>/dev/null | jq -s 'add // {}')

index=0
jq -c '
  def parsed_args:
    if (.payload.arguments | type) == "string" then
      ((.payload.arguments | fromjson?) // .payload.arguments)
    elif (.payload.arguments | type) == "object" then
      .payload.arguments
    else
      {}
    end;

  def summary_for_call:
    if .payload.type == "function_call" then
      (
        parsed_args.cmd //
        parsed_args.file_path //
        parsed_args.pattern //
        parsed_args.prompt //
        parsed_args.url //
        parsed_args.query //
        (.payload.arguments | tostring)
      ) | tostring | .[0:100]
    else
      (.payload.input // "" | tostring | .[0:100])
    end;

  select(
    .type == "response_item" and
    (.payload.type == "function_call" or .payload.type == "custom_tool_call")
  ) |
  {
    id: .payload.call_id,
    name: .payload.name,
    summary: summary_for_call
  }
' "$FILE" 2>/dev/null | while IFS= read -r tool; do
  index=$((index + 1))
  name=$(echo "$tool" | jq -r '.name')
  tool_id=$(echo "$tool" | jq -r '.id')
  input_summary=$(echo "$tool" | jq -r '.summary')
  output=$(echo "$tool_results_json" | jq -r --arg id "$tool_id" '.[$id] // ""')

  if is_codex_error_output "$output"; then
    status="ERROR"
  else
    status="OK"
  fi

  printf "[%3d] %-12s | %-100s | %s\n" "$index" "$name" "$input_summary" "$status"
done
