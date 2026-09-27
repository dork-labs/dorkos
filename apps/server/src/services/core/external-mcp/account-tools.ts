/**
 * Puts the account tools (`accounts_usage`) on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas come from `getAccountTools`, the
 * same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here.
 *
 * @module services/core/external-mcp/account-tools
 */
import { z } from 'zod';
import { AccountUsageSchema } from '@dorkos/shared/account-usage';
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { getAccountTools } from '../../runtimes/claude-code/mcp-tools/account-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

/** The external-only additions for each account tool. */
const ACCOUNT_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  accounts_usage: {
    annotations: ToolAnnotationPresets.readOnlyLocal,
    outputSchema: { accounts: z.array(AccountUsageSchema) },
  },
};

/**
 * Register `accounts_usage` against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerAccountTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, getAccountTools(deps), ACCOUNT_EXTERNAL_CONFIGS);
}
