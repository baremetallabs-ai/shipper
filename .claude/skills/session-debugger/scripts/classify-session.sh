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

# Get first user message content (longer preview to capture labels)
prompt_preview=$(echo "$first_user" | jq -r '
  if (.message.content | type) == "string" then
    .message.content[:2000]
  elif (.message.content | type) == "array" then
    [.message.content[] | select(.type == "text") | .text][0][:2000] // ""
  else
    ""
  end
')

# Extract issue/PR number from prompt or branch
issue_num=""
if [[ "$branch" =~ ([0-9]+) ]]; then
  issue_num="${BASH_REMATCH[1]}"
fi

# --- Stage detection (priority: tool calls > prompt labels > CWD/branch > unknown) ---
stage=""

# Priority 1: Check for characteristic tool calls (most specific)
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

# Priority 2: Check prompt labels (if tool calls didn't determine stage)
if [[ -z "$stage" ]]; then
  if echo "$prompt_preview" | grep -q 'shipper:pr-open'; then
    # Session started with pr-open label — could be pr-review or pr-remediate
    if echo "$prompt_preview" | grep -qiE '(pull request|PR #|diff|review)'; then
      stage="pr-review"
    else
      stage="pr-review"
    fi
  elif echo "$prompt_preview" | grep -q 'shipper:implemented'; then
    stage="pr-open"
  elif echo "$prompt_preview" | grep -q 'shipper:planned'; then
    stage="implement"
  elif echo "$prompt_preview" | grep -q 'shipper:designed'; then
    stage="plan"
  elif echo "$prompt_preview" | grep -q 'shipper:groomed'; then
    stage="design"
  elif echo "$prompt_preview" | grep -q 'shipper:new'; then
    stage="groom"
  fi
fi

# Priority 3: CWD/branch hints
if [[ -z "$stage" ]]; then
  if [[ "$cwd" == *"shipper-worktrees"* ]] || [[ "$cwd" == *"--wt--"* ]]; then
    stage="implement"
  fi
fi

# Fallback
if [[ -z "$stage" ]]; then
  stage="unknown"
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
