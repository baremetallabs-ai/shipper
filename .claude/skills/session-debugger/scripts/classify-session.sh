#!/usr/bin/env bash
# Classify a Claude Code session transcript by shipper stage.
# Usage: classify-session.sh <jsonl-file-path>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: classify-session.sh <jsonl-file-path>" >&2
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

# Extract first user record metadata
first_user=$(jq -c 'select(.type == "user" and (.toolUseResult | not))' "$FILE" | head -1)

if [[ -z "$first_user" ]]; then
  echo "Error: no user message found in $FILE" >&2
  exit 1
fi

cwd=$(echo "$first_user" | jq -r '.cwd // "unknown"')
branch=$(echo "$first_user" | jq -r '.gitBranch // "unknown"')

# Get first user message content (could be string or array)
prompt_preview=$(echo "$first_user" | jq -r '
  if (.message.content | type) == "string" then
    .message.content[:200]
  elif (.message.content | type) == "array" then
    [.message.content[] | select(.type == "text") | .text][0][:200] // ""
  else
    ""
  end
')

# Extract issue/PR number from prompt or branch
issue_num=""
if [[ "$branch" =~ ([0-9]+) ]]; then
  issue_num="${BASH_REMATCH[1]}"
fi

# Scan assistant records for characteristic tool calls to determine stage
stage="unknown"

# Check for gh commands in Bash tool calls
gh_commands=$(jq -r '
  select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use" and .name == "Bash") |
  .input.command // ""
' "$FILE" 2>/dev/null)

if echo "$gh_commands" | grep -q 'gh pr create'; then
  stage="pr-open"
elif echo "$gh_commands" | grep -q 'gh pr review'; then
  stage="pr-review"
elif echo "$gh_commands" | grep -q 'shipper:implemented'; then
  stage="implement"
fi

# Check for verdict keywords in assistant text (remediation)
verdict_text=$(jq -r '
  select(.type == "assistant") |
  .message.content[]? |
  select(type == "object" and .type == "text") |
  .text
' "$FILE" 2>/dev/null)

if echo "$verdict_text" | grep -qE '\b(READY|RETRY|NEEDS UPSTREAM)\b'; then
  stage="pr-remediate"
fi

# Build summary from first assistant text
summary=$(jq -r '
  select(.type == "assistant") |
  .message.content[]? |
  select(type == "object" and .type == "text") |
  .text
' "$FILE" 2>/dev/null | head -1 | cut -c1-120)

echo "Stage:   $stage"
echo "Issue:   ${issue_num:-unknown}"
echo "Branch:  $branch"
echo "CWD:     $cwd"
echo "Summary: ${summary:-<no text>}"
