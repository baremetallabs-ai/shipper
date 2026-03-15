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

meta_file_for() {
  echo "${1%.jsonl}.meta.json"
}

detect_agent() {
  local meta
  local first_type

  meta=$(meta_file_for "$1")
  if [[ -f "$meta" ]]; then
    local meta_agent
    meta_agent=$(jq -r '.agent // empty' "$meta" 2>/dev/null || true)
    if [[ -n "$meta_agent" ]]; then
      echo "$meta_agent"
      return
    fi
  fi

  first_type=$(head -n 1 "$1" | jq -r '.type // ""' 2>/dev/null || true)
  if [[ "$first_type" == "session_meta" ]]; then
    echo "codex"
  else
    echo "claude"
  fi
}

is_raw_codex_capture() {
  local file="$1"
  local agent="$2"
  [[ "$agent" == "codex" ]] && ! head -n 1 "$file" | jq -e . >/dev/null 2>&1
}

print_raw_capture_message() {
  echo "Raw capture file - structured extraction requires native Codex transcripts under ~/.codex/sessions/"
}

CODEX_ERROR_PATTERN='fatal:|[Ee]rror:|EACCES|ENOENT|EPERM|Permission denied|command not found|No such file|403 Forbidden|404 Not Found|401 Unauthorized|exit code [1-9]|exit status [1-9]|[Ff]ailed to|FAILED|panic:|Traceback|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError|Process exited with code [1-9]|Exit code: [1-9]|could not lock config file|unable to write upstream branch configuration|cannot lock ref|cannot create temp file for here document|sandbox.*denied|not allowed in sandbox|execution not permitted|unable to create .+\.lock'

strip_codex_noise() {
  printf '%s\n' "$1" | grep -vE '^/opt/homebrew/.*/bin/ps: Operation not permitted$' || true
}

codex_error_match() {
  local cleaned="$1"
  printf '%s\n' "$cleaned" | grep -qE "$CODEX_ERROR_PATTERN" 2>/dev/null
}

find_error_line() {
  printf '%s\n' "$1" |
    grep -E "$CODEX_ERROR_PATTERN" |
    head -1 |
    cut -c1-160
}

agent=$(detect_agent "$FILE")

if is_raw_codex_capture "$FILE" "$agent"; then
  print_raw_capture_message
  exit 0
fi

if [[ "$agent" == "claude" ]]; then
  ERROR_PATTERN='fatal:|[Ee]rror:|EACCES|ENOENT|EPERM|Permission denied|command not found|No such file|403 Forbidden|404 Not Found|401 Unauthorized|exit code [1-9]|exit status [1-9]|[Ff]ailed to|FAILED|panic:|Traceback|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError'

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

  results_by_id=$(echo "$tool_results_map" | jq -s 'map({(.id): {is_error, content}}) | add // {}')

  found_errors=false
  index=0
  while IFS= read -r tool; do
    index=$((index + 1))
    name=$(echo "$tool" | jq -r '.name')
    tool_id=$(echo "$tool" | jq -r '.id')

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
      error_line=$(echo "$content" | grep -oE ".{0,120}($ERROR_PATTERN).{0,40}" | head -1 || echo "$content" | head -1 | cut -c1-120)
      printf "[%3d] %-12s | %-13s | %s\n" "$index" "$name" "$error_type" "$input_summary"
      printf "      %s\n" "$error_line"
    fi
  done < <(jq -c '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use") |
    {id, name, input}
  ' "$FILE" 2>/dev/null)

  if [[ "$found_errors" == false ]]; then
    echo "No errors found."
  fi

  exit 0
fi

tool_results_json=$(jq -c '
  select(
    .type == "response_item" and
    (.payload.type == "function_call_output" or .payload.type == "custom_tool_call_output")
  ) |
  {(.payload.call_id): (.payload.output // "")}
' "$FILE" 2>/dev/null | jq -s 'add // {}')

found_errors=false
index=0
while IFS= read -r tool; do
  index=$((index + 1))
  name=$(echo "$tool" | jq -r '.name')
  tool_id=$(echo "$tool" | jq -r '.id')
  input_summary=$(echo "$tool" | jq -r '.input_summary')
  content=$(echo "$tool_results_json" | jq -r --arg id "$tool_id" '.[$id] // ""')
  cleaned=$(strip_codex_noise "$content")

  if codex_error_match "$cleaned"; then
    found_errors=true
    error_line=$(find_error_line "$cleaned")
    printf "[%3d] %-12s | %-13s | %s\n" "$index" "$name" "CONTENT_ERROR" "$input_summary"
    printf "      %s\n" "$error_line"
  fi
done < <(jq -c '
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
      ) | tostring | .[0:80]
    else
      (.payload.input // "" | tostring | .[0:80])
    end;

  select(
    .type == "response_item" and
    (.payload.type == "function_call" or .payload.type == "custom_tool_call")
  ) |
  {
    id: .payload.call_id,
    name: .payload.name,
    input_summary: summary_for_call
  }
' "$FILE" 2>/dev/null)

assistant_messages=$(jq -r '
  select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") |
  [.payload.content[]? | select(.type == "output_text") | .text] | join("\n")
' "$FILE" 2>/dev/null)

assistant_index=$index
while IFS= read -r message; do
  [[ -n "$message" ]] || continue
  if echo "$message" | grep -qiE '((blocked|sandbox).*(~/.claude(\.json|/|\*)|real home directory)|(~/.claude(\.json|/|\*)|real home directory).*(blocked|sandbox))'; then
    assistant_index=$((assistant_index + 1))
    found_errors=true
    error_line=$(echo "$message" | grep -ioE '.{0,120}((blocked|sandbox).*(~/.claude(\.json|/|\*)|real home directory)|(~/.claude(\.json|/|\*)|real home directory).*(blocked|sandbox)).{0,40}' | head -1 || echo "$message" | head -1 | cut -c1-120)
    printf "[%3d] %-12s | %-13s | %s\n" "$assistant_index" "Assistant" "CONTENT_ERROR" "runtime conclusion"
    printf "      %s\n" "$error_line"
  fi
done <<<"$assistant_messages"

if [[ "$found_errors" == false ]]; then
  echo "No errors found."
fi
