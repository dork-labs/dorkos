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
/**
 * The sentence naming the chat tools Doe really has loaded, or `''`.
 *
 * Doe reaches DorkOS only through the host MCP server, which carries the
 * capability tools. The chat tools are capabilities, so they arrive when the
 * host connected; `mesh_list` and `mesh_inspect` are hand-registered on Claude
 * Code and never reach Doe, so they are not named. `chat_send` and `chat_read`
 * load up front only for an agent session (`loadsAgentToAgentTools`), and a
 * tool the agent's permissions hide is not claimed at all.
 *
 * @param hostConnected - Whether the host MCP server connected this turn.
 * @param agentToAgent - `loadsAgentToAgentTools`'s answer for this session.
 * @param hidden - The tool names the agent's permissions hide.
 */
export function chatToolsLine(
  hostConnected: boolean,
  agentToAgent: boolean,
  hidden: ReadonlySet<string>
): string {
  if (!hostConnected || !agentToAgent) return '';
  const parts: string[] = [];
  if (!hidden.has('chat_send')) parts.push('chat_send messages another chat or agent');
  if (!hidden.has('chat_read')) parts.push('chat_read checks on one');
  if (parts.length === 0) return '';
  const names = ['chat_send', 'chat_read'].filter((name) => !hidden.has(name)).join(' and ');
  const [noun, verb] = parts.length === 1 ? ['Chat tool', 'is'] : ['Chat tools', 'are'];
  return `${noun} ${names} ${verb} loaded: ${parts.join(', and ')}. Use tool_search to discover other tools.`;
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
  const visibility = options.hostConnected
    ? await resolveToolVisibilityFor(options.agentPath)
    : undefined;
  const blocked = visibility ? renderBlockedAreaLines(visibility.blockedAreas) : '';
  return [
    GEN_UI_CONTEXT,
    append.text,
    options.hostConnected ? buildRoomToolsBlock('') : '',
    blocked,
    chatToolsLine(
      options.hostConnected,
      options.agentToAgent ?? false,
      visibility?.hiddenToolNames ?? new Set()
    ),
    options.opts?.systemPromptAppend ?? '',
    ...(options.opts?.additionalContext ?? []).map(renderDoeContextEntry),
  ]
    .filter(Boolean)
    .join('\n\n');
}
