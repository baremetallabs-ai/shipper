#!/usr/bin/env bash
# Extract the last assistant message from a Claude Code or Codex CLI session transcript.
# Usage: extract-final-message.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: extract-final-message.sh <jsonl-file-path>" >&2
  exit 1
fi

FILE="$1"
META_FILE="${FILE%.jsonl}.meta.json"
RAW_CODEX_CAPTURE_MSG="This is a raw capture file - structured extraction requires native Codex transcripts under ~/.codex/sessions/"

if [[ ! -f "$FILE" ]]; then
  echo "Error: file not found: $FILE" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 1
fi

detect_agent() {
  local meta_agent
  local first_type

  if [[ -f "$META_FILE" ]]; then
    meta_agent=$(jq -r '.agent // ""' "$META_FILE" 2>/dev/null)
    if [[ -n "$meta_agent" ]]; then
      echo "$meta_agent"
      return
    fi
  fi

  first_type=$(head -n 1 "$1" | jq -r '.type // ""' 2>/dev/null)
  if [[ "$first_type" == "session_meta" ]]; then
    echo "codex"
  else
    echo "claude"
  fi
}

is_json_capture() {
  local first_line

  first_line=$(head -n 1 "$1" 2>/dev/null || true)
  [[ -n "$first_line" ]] || return 1
  printf '%s\n' "$first_line" | jq -e . >/dev/null 2>&1
}

agent=$(detect_agent "$FILE")

if [[ "$agent" == "codex" ]] && ! is_json_capture "$FILE"; then
  echo "$RAW_CODEX_CAPTURE_MSG"
  exit 0
fi

if [[ "$agent" == "claude" ]]; then
  last_assistant=$(jq -c 'select(.type == "assistant")' "$FILE" 2>/dev/null | tail -1)

  if [[ -z "$last_assistant" ]]; then
    echo "No assistant messages found." >&2
    exit 1
  fi

  echo "$last_assistant" | jq -r '
    [.message.content[]? | select(type == "object" and .type == "text") | .text] | join("\n")
  '

  exit 0
fi

last_assistant=$(jq -c '
  select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant")
' "$FILE" 2>/dev/null | tail -1)

if [[ -z "$last_assistant" ]]; then
  echo "No assistant messages found." >&2
  exit 1
fi

echo "$last_assistant" | jq -r '
  [.payload.content[]? | select(.type == "output_text") | .text] | join("\n")
'
