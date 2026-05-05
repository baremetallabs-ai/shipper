import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getRepoNwo,
  loadSettings,
  runAuthPreflight,
  runPreflight,
} from '@baremetallabs-ai/shipper-core';
import { resolveAndEnterRepoDir } from './repo-dir.js';
import { registerInitErrorTools, registerTools } from './tools.js';

const VERSION = process.env.SHIPPER_MCP_VERSION ?? '0.0.0';

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'shipper', version: VERSION });

  try {
    await resolveAndEnterRepoDir();
    await loadSettings();
    await runAuthPreflight();
    const repo = await getRepoNwo();
    await runPreflight(repo);
    await registerTools(server, repo);
  } catch (error) {
    registerInitErrorTools(server, error);
  }

  return server;
}
