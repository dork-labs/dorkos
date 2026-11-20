import type { McpServerEntry } from '@dorkos/shared/transport';
import { mcpAuthEvidenceFrom, type McpAuthEvidencePort } from '../../../mesh/mcp-revocation.js';

/** Forward one actual status snapshot to its current revocation observer, without retaining state. */
export function reportClaudeMcpAuthFailures(
  port: McpAuthEvidencePort | undefined,
  sessionId: string,
  cwd: string,
  servers: McpServerEntry[]
): void {
  if (!port) return;
  const serverNames = mcpAuthEvidenceFrom(servers);
  if (serverNames.length === 0) return;
  port({ sessionId, cwd, serverNames });
}
