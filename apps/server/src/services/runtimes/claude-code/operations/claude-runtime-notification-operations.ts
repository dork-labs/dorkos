import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { type PaidPluginReload } from '../messaging/plugin-reload-policy.js';
import { logger } from '../../../../lib/logger.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { mcpAuthEvidenceFrom } from '../../../mesh/mcp-revocation.js';

/** Execute original reportMcpAuthFailures behavior after actual runtime private-key admission. */
export function reportMcpAuthFailures(
  ownerKey: object,
  sessionId: string,
  cwd: string,
  servers: McpServerEntry[]
): void {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const port = facet.mcpAuthEvidence;
  if (!port) return;
  const serverNames = mcpAuthEvidenceFrom(servers);
  if (serverNames.length === 0) return;
  port({ sessionId, cwd, serverNames });
}

/** Execute original broadcastCommandsChanged behavior after actual runtime private-key admission. */
export function broadcastCommandsChanged(ownerKey: object): void {
  readOriginalClaudeNativePreparationView(ownerKey);
  try {
    eventFanOut.broadcast('commands_changed', { changedAt: new Date().toISOString() });
  } catch (err) {
    // warn, not debug: a failed broadcast means OTHER connected windows never
    // learn to re-fetch, so their command palette stays stale until a manual
    // reload (the initiating window still has its mutation-side invalidation).
    logger.warn('[refreshActivatedPlugins] commands_changed broadcast failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Execute original recordPaidPluginReload behavior after actual runtime private-key admission. */
export function recordPaidPluginReload(ownerKey: object, entry: PaidPluginReload): void {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const port = facet.pluginReloadActivity;
  if (!port) return;
  port(entry);
}

/** Execute original forgetProjectCommands behavior after actual runtime private-key admission. */
export function forgetProjectCommands(ownerKey: object, projectPath: string): void {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  facet.cache.clearSdkCommands(projectPath);
  facet.warmFailedAt.delete(projectPath);
}
