import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRepoNwo, loadSettings, runPreflight } from '@dnsquared/shipper-core';
import { registerInitErrorTools, registerTools } from './tools.js';

const VERSION = process.env.SHIPPER_MCP_VERSION ?? '0.0.0';

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'shipper', version: VERSION });

  try {
    await loadSettings();
    const repo = await getRepoNwo();
    await runPreflight(repo);
    registerTools(server, repo);
  } catch (error) {
    registerInitErrorTools(server, error);
  }

  return server;
}
