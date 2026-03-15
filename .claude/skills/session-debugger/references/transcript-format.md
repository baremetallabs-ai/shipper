# Shipper-Captured Session Format

Headless shipper runs now write a shipper-owned session pair under `~/.shipper/sessions/<slug>/`:

- `<issue-or-unlinked>-<stage>-<timestamp>.jsonl`
- `<issue-or-unlinked>-<stage>-<timestamp>.meta.json`

The repo slug is normally `<owner>-<repo>`. When `runPrompt()` has no repo, shipper falls back to `basename(process.cwd())`, which keeps repo-less `setup` sessions out of ephemeral worktrees while still making them discoverable.

## Metadata Sidecar

Each `.meta.json` file contains:

```json
{
  "repo": "owner/repo",
  "issue": "308",
  "stage": "implement",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-03-15T14:00:01.234Z",
  "exitCode": 0,
  "logFile": "/Users/dan/.shipper/sessions/owner-repo/308-implement-2026-03-15T14-00-01-234Z.jsonl"
}
```

The session-debugger scripts use the sidecar as the primary index:

- `find-sessions.sh` reads `.meta.json` instead of grepping transcript bodies
- `classify-session.sh` trusts `agent`, `stage`, and `issue` from metadata when present
- extractor scripts use the `.meta.json` sibling to detect the agent type reliably

## Claude Headless Capture

Claude headless runs are captured with `--verbose --output-format stream-json`. The output is JSONL and includes:

- `system` records at the start
- `assistant` and `user` records that retain the same `message.content[]` structure used by the existing extractor jq filters
- a trailing `result` record

The debugger scripts intentionally ignore the extra `system` and `result` records and operate on the `assistant` / `user` messages.

## Codex Headless Capture

Codex headless runs are captured as raw stdout in v1. Metadata discovery still works, but structured extraction does not. The debugger scripts return a clear unsupported/raw-capture message and direct you to native Codex transcripts under `~/.codex/sessions/` when you need tool-level parsing.

# Claude Code Transcript Format

Session transcripts are JSONL files stored under `~/.claude/projects/`. Each line is a self-contained JSON object representing one event in the conversation.

## Where Transcripts Live

Claude Code uses path-based directory naming under `~/.claude/projects/`:

| Context          | Directory pattern                                     |
| ---------------- | ----------------------------------------------------- |
| Main repo        | `-Users-dan-repos-<repo>/`                            |
| Shipper worktree | `-Users-dan--shipper-worktrees-<repo>--wt--<branch>/` |

Each directory contains one or more `<uuid>.jsonl` files (one per session) and optionally a `subagents/` subdirectory.

### Finding the right project directory

Shipper creates worktrees with branch names like `shipper/<N>-<slug>`, which map to directory names like:

```
-Users-dan--shipper-worktrees-<repo>--wt--shipper-<N>-<slug>/
```

To find sessions for issue #42, search for directories matching `*shipper-worktrees-<repo>--wt--*-42-*` or `*shipper-42-*`.

## JSONL Record Types

Every record has a `type` field. The key types are:

### `queue-operation`

Session lifecycle events (enqueue/dequeue).

```json
{
  "type": "queue-operation",
  "operation": "dequeue",
  "timestamp": "2026-03-03T23:27:57.751Z",
  "sessionId": "282256f6-..."
}
```

### `user`

User messages. The first `user` record contains the shipper prompt and session metadata.

```json
{
  "type": "user",
  "userType": "external",
  "cwd": "/Users/dan/.shipper/worktrees/repo--wt--shipper-1-slug",
  "gitBranch": "shipper/1-slug",
  "message": {
    "role": "user",
    "content": "# Issue #1: Title\n**State:** OPEN | ..."
  },
  "sessionId": "282256f6-...",
  "timestamp": "2026-03-03T23:27:57.758Z"
}
```

Tool results also appear as `user` records with a `toolUseResult` field:

```json
{
  "type": "user",
  "toolUseResult": {
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false,
    "stdout": "...",
    "stderr": "..."
  },
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01W5KNat...",
        "content": "...",
        "is_error": false
      }
    ]
  }
}
```

### `assistant`

Model responses. Content is an array of text blocks and tool_use blocks.

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "I'll start by..." },
      {
        "type": "tool_use",
        "id": "toolu_01W5KNat...",
        "name": "Bash",
        "input": { "command": "gh pr list", "description": "List PRs" }
      }
    ]
  }
}
```

### `progress`

Hook execution and other progress events. Contains a `data` field with event details.

```json
{
  "type": "progress",
  "data": { "type": "hook_progress", "hookEvent": "PreToolUse", "hookName": "PreToolUse:Bash" },
  "toolUseID": "toolu_01W5KNat..."
}
```

### `system`

System events like API errors and retries.

## Identifying Sessions Among Many Files

A project directory may contain dozens of JSONL files. To identify which session is which:

1. **Sort by mtime** — `ls -lt *.jsonl` shows most recent first
2. **Read the first user message** — the prompt text identifies the shipper stage
3. **Check the `gitBranch` field** — confirms the issue number

## Matching Sessions to Shipper Stages

Inspect assistant tool calls to determine what stage a session ran:

| Stage            | Characteristic tool calls / patterns                 |
| ---------------- | ---------------------------------------------------- |
| **implement**    | `gh issue edit --add-label "shipper:implemented"`    |
| **pr-open**      | `gh pr create`                                       |
| **pr-review**    | `gh pr review`                                       |
| **pr-remediate** | Verdict keywords: `READY`, `RETRY`, `NEEDS UPSTREAM` |

## Extracting Tool Calls

Tool calls live in `assistant` records under `message.content[]` where `type == "tool_use"`. Each has:

- `name` — tool name (Bash, Read, Write, Edit, Glob, Grep, etc.)
- `id` — unique ID linking to the tool result
- `input` — tool-specific parameters

The matching tool result is a `user` record where `message.content[].tool_use_id` matches the tool's `id`. Check `is_error` on the tool_result content block and `toolUseResult.stderr` for error details.

### Key input fields by tool

| Tool  | Key input field |
| ----- | --------------- |
| Bash  | `command`       |
| Read  | `file_path`     |
| Write | `file_path`     |
| Edit  | `file_path`     |
| Glob  | `pattern`       |
| Grep  | `pattern`       |
| Task  | `prompt`        |

## Extracting Verdicts

Remediation sessions produce a verdict in assistant text content. Look for:

- **READY** — PR passed review, ready to merge
- **RETRY** — PR needs fixes, agent will retry
- **NEEDS UPSTREAM** — issue requires human intervention

Also check for `gh issue edit` calls that change labels (label transitions) and `gh issue comment` / `gh pr comment` calls (posted comments).

## Common Failure Patterns

| Pattern                  | Symptom                                                       | Where to look                                           |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------- |
| Push blocked by sandbox  | `fatal: could not read Username` or permission denied on push | Bash tool results with `is_error: true`                 |
| UNKNOWN merge state      | `gh pr view` returns unexpected merge status                  | Bash tool calls querying PR state                       |
| Identity confusion       | Agent addresses wrong issue or repo                           | First user message content vs. actual tool call targets |
| Label-change parse error | `gh issue edit` called with malformed label args              | Bash tool calls containing `gh issue edit`              |
| Hook rejection           | Pre-tool-use hook blocks a tool call                          | `progress` records with `hook_progress` type            |

# Codex CLI Transcript Format

Codex saves session transcripts as JSONL files under `~/.codex/sessions/YYYY/MM/DD/`. Each line is a self-contained event, but the record families differ from Claude Code.

## Where Transcripts Live

Codex uses date-based storage with one file per rollout:

```
~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<uuid>.jsonl
```

Unlike Claude's project-directory layout, Codex does not group sessions by repo path. Session discovery relies on transcript content:

- `session_meta.payload.cwd` identifies the repo or worktree path
- the initial user messages contain the wrapped prompt text, including `Issue #<N>` for main-repo stages

## JSONL Record Types

The current shipper Codex sessions use these top-level record types:

### `session_meta`

The first line contains session metadata:

```json
{
  "type": "session_meta",
  "payload": {
    "cwd": "/Users/dan/.shipper/worktrees/repo--wt--shipper-150-some-slug",
    "git": { "branch": "shipper/150-some-slug" },
    "timestamp": "2026-03-06T22:44:14.000Z",
    "model_provider": "openai"
  }
}
```

Useful fields:

- `payload.cwd` — repo/worktree path
- `payload.git.branch` — current branch name
- `payload.timestamp` — session start time
- `payload.model_provider` — provider name

### `response_item`

Most meaningful transcript content appears here. The `payload.type` field distinguishes the subtype.

#### User and assistant messages

Codex message records use `payload.type == "message"`:

```json
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [{ "type": "output_text", "text": "I’m checking the issue state first." }]
  }
}
```

- `payload.role == "user"` contains setup text plus the wrapped shipper prompt
- `payload.role == "assistant"` contains the visible assistant output
- assistant text lives in `payload.content[]` entries with `type == "output_text"`
- user prompt text lives in `payload.content[]` entries with `type == "input_text"`

Shipper Codex runs usually start with multiple user/setup messages. The actual shipper prompt is the last initial user message before the first assistant reply, not a fixed record number.

#### Standard tool calls

Developer tools such as `exec_command`, `write_stdin`, and `update_plan` use `function_call` / `function_call_output` pairs:

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "exec_command",
    "call_id": "call_abc123",
    "arguments": "{\"cmd\":\"git status --short\"}"
  }
}
```

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_abc123",
    "output": "Chunk ID: ...\nProcess exited with code 0\nOutput:\n..."
  }
}
```

Notes:

- `payload.call_id` joins the call to its result
- `payload.name` is the tool name
- `payload.arguments` is currently a JSON string, but scripts should also tolerate an already-decoded object

#### Custom tool calls

Some tools, notably `apply_patch`, use `custom_tool_call` / `custom_tool_call_output`:

```json
{
  "type": "response_item",
  "payload": {
    "type": "custom_tool_call",
    "name": "apply_patch",
    "call_id": "call_xyz789",
    "input": "*** Begin Patch\n..."
  }
}
```

```json
{
  "type": "response_item",
  "payload": {
    "type": "custom_tool_call_output",
    "call_id": "call_xyz789",
    "output": "{\"output\":\"Success. Updated the following files...\"}"
  }
}
```

These records use the same `call_id` join pattern as standard function calls, but the input is stored in `payload.input` instead of `payload.arguments`.

#### Reasoning records

Codex may also emit `response_item` entries with `payload.type == "reasoning"`. These are not part of the debugging workflow and can usually be ignored.

### `event_msg`

Lifecycle and telemetry events, including session completion:

```json
{
  "type": "event_msg",
  "payload": {
    "type": "task_complete",
    "last_agent_message": "..."
  }
}
```

The important session end marker is `payload.type == "task_complete"`.

Codex also mirrors commentary and token accounting in `event_msg` records, but assistant-facing text should be read from `response_item` assistant messages rather than these duplicates.

### `turn_context`

Turn-level environment metadata such as the cwd, sandbox mode, and current date.

## Matching Sessions to Shipper Stages

The same stage heuristics used for Claude apply, but the selectors differ:

| Stage            | Codex evidence                                                               |
| ---------------- | ---------------------------------------------------------------------------- |
| **implement**    | tool-call command contains `shipper:implemented`                             |
| **pr-open**      | tool-call command contains `gh pr create`                                    |
| **pr-review**    | tool-call command contains `gh pr review`                                    |
| **pr-remediate** | assistant `output_text` contains `READY`, `RETRY`, or `NEEDS UPSTREAM`       |
| **plan/design**  | prompt preview contains `shipper:designed` / `shipper:groomed` label context |

For Codex sessions, prompt previews should be taken from the last initial user message before the first assistant message.

## Extracting Tool Calls and Results

To reconstruct the tool timeline:

1. Read `response_item` records in file order
2. Select both `function_call` and `custom_tool_call`
3. Join each call to `function_call_output` or `custom_tool_call_output` using `payload.call_id`

Key fields:

| Record family      | Name field     | Input field         | Result field     |
| ------------------ | -------------- | ------------------- | ---------------- |
| `function_call`    | `payload.name` | `payload.arguments` | `payload.output` |
| `custom_tool_call` | `payload.name` | `payload.input`     | `payload.output` |

Unlike Claude, Codex has no `is_error` flag on tool results. Error detection is content-based.

## Common Codex Error Patterns

Real shipper Codex failures seen in transcripts include:

- `could not lock config file`
- `unable to write upstream branch configuration`
- `cannot lock ref`
- `cannot create temp file for here document`
- `not allowed in sandbox`
- `execution not permitted`

Pitfall: successful Codex command output can include Homebrew wrapper noise such as `/bin/ps: Operation not permitted`. That line alone is not a failure and should be ignored unless the surrounding output also contains a real error signal.
