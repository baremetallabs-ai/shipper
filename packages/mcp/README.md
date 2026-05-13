# @baremetallabs-ai/shipper-mcp

`@baremetallabs-ai/shipper-mcp` is a private workspace package that exposes Shipper workflow
operations to AI agents over Model Context Protocol stdio transport. It lets an MCP-capable agent
inspect Shipper-managed issues, create or adopt work, advance workflow stages, recover blocked
items, and read the Shipper documentation corpus without reverse-engineering the CLI.

The package is built from this monorepo and is not published as a public npm package.

## Build and Run from a Checkout

```bash
npm install
npm run build --workspace=packages/mcp
```

Configure your MCP client to run the built server with Node:

```json
{
  "mcpServers": {
    "shipper": {
      "command": "node",
      "args": ["/absolute/path/to/shipper/packages/mcp/dist/index.js"],
      "env": {
        "SHIPPER_REPO_DIR": "/absolute/path/to/target/repo"
      }
    }
  }
}
```

`SHIPPER_REPO_DIR` is optional when the MCP client starts inside the target repository. Set it when
the client launches the server from another working directory.

## Startup Behavior

The server uses stdio transport and redirects ordinary `console.log` output to stderr so stdout
stays reserved for MCP messages. On startup it:

1. Resolves the target repository from `SHIPPER_REPO_DIR` or the startup cwd.
2. Validates that the target path is a readable Git repository and enters it.
3. Loads Shipper settings.
4. Checks GitHub CLI authentication.
5. Resolves the GitHub remote.
6. Runs Shipper preflight before registering workflow tools.

If initialization fails, the server still starts and registers error-reporting tools so the agent can
surface the setup problem.

## Tool Surface

At a feature level, the MCP server exposes:

- Documentation tools for searching and reading the Shipper docs corpus.
- Read-only inspection for Shipper-managed issues and pull request check status.
- Issue lifecycle tools for creating issues, adopting existing GitHub issues, and advancing issues
  through `shipper next` once they are past intake.
- Recovery tools for reset, unblock, and stale-lock cleanup.
- Merge queue execution for ready pull requests.
- Experimental MCP-driven grooming for `shipper:new` issues, gated by
  `SHIPPER_EXPERIMENTAL_MCP_GROOMING`.

Streamed `shipper_advance` and `shipper_groom` runs are spawned with
`SHIPPER_MCP_BRIDGE=1` so `shipper_answer_question` can answer `AskUserQuestion` deferrals. The
one-shot MCP tools use non-bridged child processes and do not expose `AskUserQuestion` to headless
Claude.

The generated MCP reference documents every tool schema, result shape, and error mode.

## Documentation

- MCP reference: https://shipper.baremetallabs.ai/reference/mcp/
- Settings reference: https://shipper.baremetallabs.ai/reference/settings/
- Protocol: https://shipper.baremetallabs.ai/concepts/protocol/
