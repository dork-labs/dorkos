import { createHash } from 'node:crypto';
import type { CodexTurnTools } from '../transport/codex-transport.js';

/**
 * Digest of the credential VALUES a load carries: managed MCP header values
 * and stdio `env` values. Never stored or logged; compared only, so a refreshed
 * OAuth bearer can reload its one thread (spec §9).
 *
 * @param tools - The managed server configuration.
 */
export function credentialsOf(tools: Pick<CodexTurnTools, 'managed'>): string {
  const servers = Object.entries(tools.managed.servers)
    .map(([name, server]) => [name, (server as { env?: unknown }).env ?? null])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  const headers = Object.entries(tools.managed.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({ servers, headers })).digest('hex');
}
