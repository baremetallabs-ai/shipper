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
