/**
 * MCP tools about the Claude (and other runtimes') accounts DorkOS runs work
 * on. Today one: `accounts_usage`, how much of each account is used (spec
 * `claude-account-fleet` D2).
 *
 * The single source for the tool's name, description and input schema on BOTH
 * MCP servers: the external `/mcp` server projects these through
 * `registerFromDefinitions` (see `core/external-mcp/account-tools.ts`).
 *
 * @module services/runtimes/claude-code/mcp-tools/account-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';

/**
 * Handler for `accounts_usage`: every account of every runtime, from the usage
 * store's memory. A window with no current reading is left out, and an account
 * with nothing to go on reads `unknown`, never zero.
 */
export async function handleAccountsUsage() {
  const store = getAccountUsageStore();
  if (!store) return jsonContent({ error: 'Account usage is not available yet.' }, true);
  return structuredJsonContent({ accounts: store.list() });
}

/**
 * The account tool definitions.
 *
 * @param _deps - Shared MCP tool dependencies (unused: the store is process-wide).
 */
export function getAccountTools(_deps: McpToolDeps) {
  return [
    tool(
      'accounts_usage',
      "Read how much of each account DorkOS runs work on is used: every runtime's accounts " +
        "(registered ones, plus this computer's own sign-in as `default` when it is not " +
        'registered), each with its usage windows (used percent, reset time, status), a state ' +
        '(ok, warning, limited, unknown) and the window that limited it, if any. From memory, ' +
        'so it is cheap. Unknown is never reported as 0%.',
      {},
      handleAccountsUsage
    ),
  ];
}
