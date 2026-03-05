#!/usr/bin/env bash
# Extract the last assistant message from a Claude Code session transcript.
# Usage: extract-final-message.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: extract-final-message.sh <jsonl-file-path>" >&2
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

# Get the last assistant record and extract all text blocks
last_assistant=$(jq -c 'select(.type == "assistant")' "$FILE" 2>/dev/null | tail -1)

if [[ -z "$last_assistant" ]]; then
  echo "No assistant messages found." >&2
  exit 1
fi

echo "$last_assistant" | jq -r '
  [.message.content[]? | select(type == "object" and .type == "text") | .text] | join("\n")
'
