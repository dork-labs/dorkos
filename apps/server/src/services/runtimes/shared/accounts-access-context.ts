/** Next-turn Accounts awareness, shared across runtime transports without waking sessions. */
import type { AccountsAccessData, AdditionalContextEntry } from '@dorkos/shared/additional-context';
import {
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  type ConnectorRuntimeTools,
} from '../connector-tools.js';
import { dorkosToolNameFor } from './dorkos-tool-names.js';
import { SERVICE_CATALOG_TOOL_NAME } from '../../connectors/connector-capabilities.js';

/** Select a snapshot now; record it only after the adapter delivers the context. */
export class AccountsAccessContext {
  private readonly seen = new Map<string, string>();

  /** Read only this canonical agent/session's latest state, coalescing intervening changes. */
  async select(
    tools: ConnectorRuntimeTools,
    agentId: string,
    sessionId: string,
    turn: { readonly serviceCatalog: boolean }
  ) {
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
            serviceCatalog: turn.serviceCatalog,
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
      data: { accountCount: null, changed: false, serviceCatalog: turn.serviceCatalog },
    };
    return { entry, commit: () => {} };
  }
}

/** Render only server-authored guidance with the names exposed by this runtime. */
export function formatAccountsAccess(
  data: AccountsAccessData,
  runtime: 'claude-code' | 'codex' | 'opencode'
): string {
  // Claude Code carries the connection tools on its in-session `dorkos` server;
  // Codex and OpenCode receive them on a dedicated server of their own.
  const prefix =
    runtime === 'claude-code'
      ? dorkosToolNameFor('claude-code', '')
      : runtime === 'codex'
        ? `mcp__${CONNECTOR_RUNTIME_MCP_SERVER_NAME}__`
        : `${CONNECTOR_RUNTIME_MCP_SERVER_NAME}_`;
  const tool = (name: string) =>
    prefix + (runtime === 'opencode' ? `connectors_${name}` : `connectors.${name}`);
  // The service catalog lives on the ordinary `dorkos` server, not on the
  // dedicated connections server. Name it only when this turn attached that
  // server; a name the model cannot call is worse than none (DOR-1292).
  const lookup = data.serviceCatalog
    ? ` Its serviceSlug is an exact service id: look it up with ${dorkosToolNameFor(runtime, SERVICE_CATALOG_TOOL_NAME)} (for example {"query":"mail"}) instead of guessing.`
    : ' Its serviceSlug is an exact service id; do not guess one.';
  const status =
    data.accountCount === null
      ? 'Current account access could not be checked; this does not mean there are no accounts.'
      : `Accounts this agent session can use right now: ${data.accountCount}.`;
  return `DorkOS Connections is one list of apps: apps agents use (service actions) and chat apps (Slack/Telegram conversations).
${status}${data.changed ? ' Access changed since this session last received its account snapshot.' : ''}
Access may change during a turn. Use the injected tools below for current authority, not shell/config files or a generic app/MCP inventory.
Call ${tool('list_granted_connections')} with {} before claiming which accounts you can use. Then call ${tool('list_granted_operations')} with the returned connectionId. An account under its unavailable list was given to you but cannot be used right now: tell the owner what its note says rather than saying you have no access, and do not request it again.
Choose the exact operation matching the task and its input schema; a profile lookup cannot list messages. Copy its immutable operationRevisionId and required parameters, and use ${tool('execute_read')}, ${tool('execute_write')} or ${tool('execute_destructive')} according to its classification. Do not invent filters or treat a tool error as a result.
If you have no account for the service at all (not even under unavailable), or yours only lets you read and the task needs to change something, use ${tool('request_connection')} to ask the owner for it by level: access "read" to look at things there, "read-write" to also change things. Never name actions; it grants nothing by itself.${lookup} While it waits, say plainly that you asked for access and that the owner can answer in DorkOS, on the card in the conversation where you asked or under Needs you on the Connections page; you carry on with their answer. Every result carries a note saying what happens next: follow it and pass it on in your own words. Never send a link to DorkOS, in any chat. ${tool('get_connection_request')} checks your request. In Claude Code, load a deferred tool by its full name before calling it.
A command-line login in a shell (Composio's or any other service's) grants DorkOS nothing; only the owner connects services, in the DorkOS app.
Never ask for or inspect account credentials. These tools recheck grants on every call; approval requirements and revocations still apply.`;
}
