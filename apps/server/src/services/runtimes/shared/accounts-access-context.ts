/** Next-turn Accounts awareness, shared across runtime transports without waking sessions. */
import type { AccountsAccessData, AdditionalContextEntry } from '@dorkos/shared/additional-context';
import {
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  type ConnectorRuntimeTools,
} from '../connector-tools.js';
import { DORKOS_MCP_SERVER_NAME } from './dorkos-tool-names.js';

/** Select a snapshot now; record it only after the adapter delivers the context. */
export class AccountsAccessContext {
  private readonly seen = new Map<string, string>();

  /** Read only this canonical agent/session's latest state, coalescing intervening changes. */
  async select(tools: ConnectorRuntimeTools, agentId: string, sessionId: string) {
    const key = JSON.stringify([agentId, sessionId]);
    try {
      const snapshot = await tools.accessSnapshot?.(agentId, sessionId);
      if (snapshot) {
        const previous = this.seen.get(key);
        const entry: AdditionalContextEntry = {
          kind: 'accounts_access',
          scope: 'per-turn',
          data: {
            accountCount: snapshot.accountCount,
            changed: previous !== undefined && previous !== snapshot.revision,
          },
        };
        return {
          entry,
          commit: (canonicalSessionId = sessionId) => {
            this.seen.set(JSON.stringify([agentId, canonicalSessionId]), snapshot.revision);
          },
        };
      }
    } catch {
      // A failed awareness read must not prevent the turn or assert that access is empty.
      // Tool calls still resolve canonical authorization independently.
    }
    const entry: AdditionalContextEntry = {
      kind: 'accounts_access',
      scope: 'per-turn',
      data: { accountCount: null, changed: false },
    };
    return { entry, commit: () => {} };
  }
}

/** Render only server-authored guidance with the names exposed by this runtime. */
export function formatAccountsAccess(
  data: AccountsAccessData,
  runtime: 'claude-code' | 'codex' | 'opencode'
): string {
  const prefix =
    runtime === 'claude-code'
      ? `mcp__${DORKOS_MCP_SERVER_NAME}__`
      : runtime === 'codex'
        ? `mcp__${CONNECTOR_RUNTIME_MCP_SERVER_NAME}__`
        : `${CONNECTOR_RUNTIME_MCP_SERVER_NAME}_`;
  const tool = (name: string) =>
    prefix + (runtime === 'opencode' ? `connectors_${name}` : `connectors.${name}`);
  const status =
    data.accountCount === null
      ? 'Current account access could not be checked; this does not mean there are no accounts.'
      : `Currently granted accounts for this agent session: ${data.accountCount}.`;
  return `DorkOS Connections has Accounts (service actions) and Messaging (Slack/Telegram conversations).
${status}${data.changed ? ' Access changed since this session last received its account snapshot.' : ''}
This snapshot describes grants, not a verified service connection; access may change during a turn. Use the injected tools below for current authority, not shell/config files or a generic app/MCP inventory.
Call ${tool('list_granted_connections')} with {} before claiming which accounts you can use. Then call ${tool('list_granted_operations')} with the returned connectionId.
Choose the exact operation matching the task and its input schema; a profile lookup cannot list messages. Copy its immutable operationRevisionId and required parameters, and use ${tool('execute_read')}, ${tool('execute_write')} or ${tool('execute_destructive')} according to its classification. Do not invent filters or treat a tool error as a result.
If access is missing, use ${tool('request_connection')} to ask the owner for the needed service/actions; it grants nothing by itself. ${tool('get_connection_request')} checks your request. In Claude Code, load a deferred tool by its full name before calling it.
Never ask for or inspect account credentials. These tools recheck grants on every call; approval requirements and revocations still apply.`;
}
