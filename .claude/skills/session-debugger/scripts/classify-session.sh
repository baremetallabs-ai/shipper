#!/usr/bin/env bash
# Classify a Claude Code or Codex CLI session transcript by shipper stage.
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

is_json_capture() {
  head -n 1 "$1" | jq -e . >/dev/null 2>&1
}

extract_issue_num() {
  local branch="$1"
  local prompt="$2"

  if [[ "$branch" =~ [/-]([0-9]+)([-/]|$) ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$prompt" =~ Issue\ #([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  echo "unknown"
}

agent=$(detect_agent "$FILE")
meta_file=$(meta_file_for "$FILE")
stage=""
repo="unknown"
cwd="unknown"
branch="unknown"
prompt_preview=""
summary=""
verdict_text=""
command_text=""

if [[ -f "$meta_file" ]]; then
  repo=$(jq -r '.repo // "unknown"' "$meta_file" 2>/dev/null || echo "unknown")
  stage=$(jq -r '.stage // "unknown"' "$meta_file" 2>/dev/null || echo "unknown")
  issue_num=$(jq -r '.issue // "unknown"' "$meta_file" 2>/dev/null || echo "unknown")

  if [[ "$agent" == "claude" ]]; then
    summary=$(jq -r '
      select(.type == "assistant") |
      .message.content[]? |
      select(type == "object" and .type == "text") |
      .text
    ' "$FILE" 2>/dev/null | head -1 | cut -c1-120)
  elif ! is_json_capture "$FILE"; then
    summary="<unavailable for raw capture>"
  fi

  echo "Agent:   $agent"
  echo "Stage:   ${stage:-unknown}"
  echo "Repo:    ${repo:-unknown}"
  echo "Issue:   ${issue_num:-unknown}"
  echo "Branch:  $branch"
  echo "CWD:     $cwd"
  echo "Summary: ${summary:-<no text>}"
  exit 0
fi

if [[ "$agent" == "claude" ]]; then
  first_user=$(jq -c 'select(.type == "user" and (.toolUseResult | not))' "$FILE" | head -1)

  if [[ -z "$first_user" ]]; then
    echo "Error: no user message found in $FILE" >&2
    exit 1
  fi

  cwd=$(echo "$first_user" | jq -r '.cwd // "unknown"')
  branch=$(echo "$first_user" | jq -r '.gitBranch // "unknown"')

  prompt_preview=$(echo "$first_user" | jq -r '
    if (.message.content | type) == "string" then
      .message.content[:2000]
    elif (.message.content | type) == "array" then
      [.message.content[] | select(.type == "text") | .text][0][:2000] // ""
    else
      ""
    end
  ')

  command_text=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(.type == "tool_use" and .name == "Bash") |
    .input.command // ""
  ' "$FILE" 2>/dev/null)

  verdict_text=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(type == "object" and .type == "text") |
    .text
  ' "$FILE" 2>/dev/null)

  summary=$(jq -r '
    select(.type == "assistant") |
    .message.content[]? |
    select(type == "object" and .type == "text") |
    .text
  ' "$FILE" 2>/dev/null | head -1 | cut -c1-120)
else
  session_meta=$(jq -c 'select(.type == "session_meta")' "$FILE" | head -1)

  if [[ -z "$session_meta" ]]; then
    echo "Error: no session metadata found in $FILE" >&2
    exit 1
  fi

  cwd=$(echo "$session_meta" | jq -r '.payload.cwd // "unknown"')
  branch=$(echo "$session_meta" | jq -r '.payload.git.branch // "unknown"')

  prompt_preview=$(jq -rs '
    reduce .[] as $line (
      {seen_assistant: false, last_user: ""};
      if .seen_assistant then
        .
      elif ($line.type == "response_item" and $line.payload.type == "message" and $line.payload.role == "assistant") then
        .seen_assistant = true
      elif ($line.type == "response_item" and $line.payload.type == "message" and $line.payload.role == "user") then
        .last_user = ([ $line.payload.content[]? | select(.type == "input_text") | .text ] | join("\n"))
      else
        .
      end
    ) | .last_user[:2000]
  ' "$FILE" 2>/dev/null)

  command_text=$(jq -r '
    def parsed_args:
      if (.payload.arguments | type) == "string" then
        ((.payload.arguments | fromjson?) // {})
      elif (.payload.arguments | type) == "object" then
        .payload.arguments
      else
        {}
      end;

    select(
      .type == "response_item" and
      (.payload.type == "function_call" or .payload.type == "custom_tool_call")
    ) |
    if .payload.type == "function_call" then
      (parsed_args.cmd // (.payload.arguments | tostring))
    else
      (.payload.input // "")
    end
  ' "$FILE" 2>/dev/null)

  verdict_text=$(jq -r '
    select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") |
    [.payload.content[]? | select(.type == "output_text") | .text] | join("\n")
  ' "$FILE" 2>/dev/null)

  summary=$(jq -r '
    select(.type == "response_item" and .payload.type == "message" and .payload.role == "assistant") |
    [.payload.content[]? | select(.type == "output_text") | .text] | join("\n")
  ' "$FILE" 2>/dev/null | head -1 | cut -c1-120)
fi

issue_num=$(extract_issue_num "$branch" "$prompt_preview")

# Priority 1: tool calls and verdict keywords
if echo "$command_text" | grep -q 'gh pr create'; then
  stage="pr-open"
elif echo "$command_text" | grep -q 'gh pr review'; then
  stage="pr-review"
elif echo "$command_text" | grep -q 'shipper:implemented'; then
  stage="implement"
fi

if echo "$verdict_text" | grep -qE '\b(READY|RETRY|NEEDS UPSTREAM)\b'; then
  stage="pr-remediate"
fi

# Priority 2: prompt labels
if [[ -z "$stage" ]]; then
  if echo "$prompt_preview" | grep -q 'shipper:pr-open'; then
    stage="pr-review"
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

# Priority 3: cwd/branch hints
if [[ -z "$stage" ]]; then
  if [[ "$cwd" == *"shipper-worktrees"* ]] || [[ "$cwd" == *"--wt--"* ]]; then
    stage="implement"
  fi
fi

if [[ -z "$stage" ]]; then
  stage="unknown"
fi

echo "Agent:   $agent"
echo "Stage:   $stage"
echo "Repo:    $repo"
echo "Issue:   $issue_num"
echo "Branch:  $branch"
echo "CWD:     $cwd"
echo "Summary: ${summary:-<no text>}"
