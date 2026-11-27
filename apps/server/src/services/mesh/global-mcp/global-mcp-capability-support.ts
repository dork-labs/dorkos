/**
 * What every person capability on `/api/mcp-servers` shares (DOR-4978): its
 * deps, and how a store refusal becomes a tool refusal with the fixed sentence
 * the hand routes answered with.
 *
 * @module services/mesh/global-mcp/global-mcp-capability-support
 */
import {
  CapabilityToolError,
  type CapabilityDeps,
} from '../../core/capabilities/capability-definition.js';
import { logger } from '../../../lib/logger.js';
import type { GlobalMcpPersonDeps } from './global-mcp-person-capabilities.js';
import { GLOBAL_MCP_STORE, NO_SUCH_SERVER } from './global-mcp-refusals.js';
import { GlobalMcpStoreError } from './global-mcp-store.js';

/**
 * The deps, or a fault: the domain is composed only with them.
 *
 * @param deps - The registry's deps.
 */
export function globalMcpDepsOf(deps: CapabilityDeps): GlobalMcpPersonDeps {
  if (!deps.globalMcpPersonDeps) throw new Error('MCP servers for every agent are unavailable.');
  return deps.globalMcpPersonDeps;
}

/** The tool code and the sentence each store refusal answers with. */
const STORE_REFUSAL: Record<GlobalMcpStoreError['code'], readonly [string, string]> = {
  not_found: ['GLOBAL_MCP_NOT_FOUND', NO_SUCH_SERVER],
  name_taken: ['GLOBAL_MCP_NAME_TAKEN', GLOBAL_MCP_STORE.nameTaken],
  reserved_name: ['GLOBAL_MCP_NAME_TAKEN', GLOBAL_MCP_STORE.reservedName],
  oauth_unsupported: ['GLOBAL_MCP_CANT_RUN', GLOBAL_MCP_STORE.oauthUnsupported],
  unsafe_command: ['GLOBAL_MCP_CANT_RUN', GLOBAL_MCP_STORE.unsafeCommand],
  unsafe_env: ['GLOBAL_MCP_CANT_RUN', GLOBAL_MCP_STORE.unsafeEnv],
  masked_value: ['GLOBAL_MCP_CANT_RUN', GLOBAL_MCP_STORE.maskedValue],
  unreadable: ['GLOBAL_MCP_UNREADABLE', GLOBAL_MCP_STORE.unreadable],
  changed: ['GLOBAL_MCP_CHANGED', GLOBAL_MCP_STORE.changed],
  secret_left: ['GLOBAL_MCP_SECRET_LEFT', GLOBAL_MCP_STORE.secretLeft],
};

/**
 * A store refusal as a tool refusal carrying its code's fixed sentence. The
 * store's own message can name a command, a folder or a setting, so only its
 * code is logged, and never into the error, which the audit observer records.
 *
 * @param err - What the store threw; anything else is thrown again.
 */
export function globalMcpStoreRefusal(err: unknown): never {
  if (!(err instanceof GlobalMcpStoreError)) throw err;
  const [code, error] = STORE_REFUSAL[err.code];
  // The code alone: a store's message can name a command, a folder or a setting.
  logger.debug('[mcp-servers] store refused', { code: err.code });
  throw new CapabilityToolError({ code, error });
}
