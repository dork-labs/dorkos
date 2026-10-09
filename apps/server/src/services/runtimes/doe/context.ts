/** Runtime-neutral context delivered on the system channel with actual callable names. */
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentHome } from '../../core/agent-identity/index.js';
import { buildAgentContextAppend } from '../shared/agent-context.js';
import { buildRoomToolsBlock } from '../shared/room-tools-context.js';
import { formatAccountsAccess } from '../shared/accounts-access-context.js';
import { formatContextWarning } from '../../session/agent-compaction/context-warning-block.js';
import { formatRoomContext } from '../shared/room-context-block.js';
import { formatApprovalVerdict } from '../shared/approval-verdict-block.js';
import { formatSeedContext } from '../shared/seed-context-block.js';
import { formatStagedContext } from '../shared/staged-context-block.js';
import { renderDocEvents } from '../../canvas/doc-channel/prompt.js';
import { GEN_UI_CONTEXT } from '../shared/gen-ui-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { connectionToolName } from './mcp.js';
/** Render all additional context kinds without inserting opaque roomTurn routing metadata. */
export function renderDoeContextEntry(entry: AdditionalContextEntry): string {
  if (entry.kind === 'doc_events') return renderDocEvents(entry.data);
  let body: string;
  switch (entry.kind) {
    case 'accounts_access':
      body = formatAccountsAccess(entry.data, 'claude-code', {
        dorkos: (name) => name,
        connector: connectionToolName,
      });
      break;
    case 'context_warning':
      body = formatContextWarning(entry.data, 'claude-code', (name) => name);
      break;
    case 'room_context':
      body = formatRoomContext(entry.data, { toolPrefix: '' });
      break;
    case 'approval_verdict':
      body = formatApprovalVerdict(entry.data);
      break;
    case 'seed_context':
      body = formatSeedContext(entry.data);
      break;
    case 'staged_context':
      body = formatStagedContext(entry.data);
      break;
    default:
      body = JSON.stringify(entry.data, null, 2);
  }
  const tag = CONTEXT_TAG[entry.kind];
  return `<${tag}>\n${body}\n</${tag}>`;
}
/** Every fresh turn receives current identity, SOUL and MemoryProvider snapshot exactly once. */
export async function buildDoeContext(options: {
  cwd: string;
  agentPath?: AgentHome;
  opts?: MessageOpts;
  hostConnected: boolean;
  agentToAgent?: boolean;
}): Promise<string> {
  const append = await buildAgentContextAppend(options.agentPath, options.cwd);
  const blocked = options.hostConnected
    ? renderBlockedAreaLines((await resolveToolVisibilityFor(options.agentPath)).blockedAreas)
    : '';
  return [
    GEN_UI_CONTEXT,
    append.text,
    options.hostConnected ? buildRoomToolsBlock('') : '',
    blocked,
    options.agentToAgent
      ? 'Peer tools mesh_list, mesh_inspect, chat_send and chat_read are loaded: chat_send messages another chat or agent, and chat_read checks on one. Use tool_search to discover other tools.'
      : '',
    options.opts?.systemPromptAppend ?? '',
    ...(options.opts?.additionalContext ?? []).map(renderDoeContextEntry),
  ]
    .filter(Boolean)
    .join('\n\n');
}
