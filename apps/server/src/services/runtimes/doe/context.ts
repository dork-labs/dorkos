/** Runtime-neutral context delivered on the system channel with actual callable names. */
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentHome } from '../../core/agent-identity/index.js';
import { buildAgentContextAppend } from '../shared/agent-context.js';
import type { AgentContextSource } from '../shared/source/agent-context-source.js';
import { buildRoomToolsBlock } from '../shared/room-tools-context.js';
import { formatAccountsAccess } from '../shared/accounts-access-context.js';
import { formatContextWarning } from '../../session/agent-compaction/context-warning-block.js';
import { formatRoomContext } from '../shared/room-context-block.js';
import { renderProseContextBlock, type ProseContextEntry } from '../shared/prose/prose-context.js';
import { renderDocEvents } from '../../canvas/doc-channel/prompt.js';
import { GEN_UI_CONTEXT } from '../shared/gen-ui-context.js';
import { dorkosToolNameFor } from '../shared/dorkos-tool-names.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { connectionToolName } from './mcp.js';
import { joinFitted, type ContextPart } from '../shared/window/context-fit.js';
/** Render all additional context kinds without inserting opaque roomTurn routing metadata. */
export function renderDoeContextEntry(entry: AdditionalContextEntry): string {
  switch (entry.kind) {
    case 'doc_events':
      return renderDocEvents(entry.data);
    case 'git_status':
    case 'env':
    case 'relay_context':
    case 'queue_note':
    case 'staged_context':
    case 'seed_context':
    case 'approval_verdict':
    case 'direct_notes':
    case 'turn_cutoff':
    case 'new_since_last_run':
      return renderProseContextBlock(entry);
    case 'accounts_access':
    case 'context_warning':
    case 'room_context':
    case 'ui_state': {
      const tag = CONTEXT_TAG[entry.kind];
      return `<${tag}>\n${renderDoeContextBody(entry)}\n</${tag}>`;
    }
  }
  const exhaustiveEntry: never = entry;
  return exhaustiveEntry;
}

/** Render a Doe-specific body for a context kind outside the shared prose dispatch. */
function renderDoeContextBody(
  entry: Exclude<AdditionalContextEntry, ProseContextEntry | { kind: 'doc_events' }>
): string {
  switch (entry.kind) {
    case 'accounts_access':
      return formatAccountsAccess(entry.data, 'claude-code', {
        dorkos: (name) => dorkosToolNameFor('doe', name),
        connector: connectionToolName,
      });
    case 'context_warning':
      return formatContextWarning(entry.data, 'claude-code', (name) =>
        dorkosToolNameFor('doe', name)
      );
    case 'room_context':
      return formatRoomContext(entry.data, { toolPrefix: dorkosToolNameFor('doe', '') });
    case 'ui_state':
      return JSON.stringify(entry.data, null, 2);
  }
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

/** What {@link buildDoeContextParts} reads. */
export interface DoeContextOptions {
  cwd: string;
  agentPath?: AgentHome;
  opts?: MessageOpts;
  hostConnected: boolean;
  agentToAgent?: boolean;
  /** Where the facts are read from; only the context viewer passes one. */
  source?: AgentContextSource;
}

/**
 * The Doe context as tagged parts, in prompt order, so a small window can leave
 * whole blocks out (`context-fit.ts`, DOR-2839).
 *
 * The room tools guide is marked as never left out on a room turn: there the
 * agent's only way to answer is the posting tool it describes. The chat tools
 * line rides with the DorkOS tool descriptions, because it says those tools are
 * loaded and is false once they are not.
 */
export async function buildDoeContextParts(options: DoeContextOptions): Promise<ContextPart[]> {
  const append = await buildAgentContextAppend(options.agentPath, options.cwd, options.source);
  const visibility = options.hostConnected
    ? await resolveToolVisibilityFor(options.agentPath)
    : undefined;
  const blocked = visibility ? renderBlockedAreaLines(visibility.blockedAreas) : '';
  const roomTurn = options.opts?.roomTurn !== undefined;
  const parts: ContextPart[] = [
    { block: 'gen_ui', text: GEN_UI_CONTEXT },
    ...(append.parts ?? [{ block: null, text: append.text }]),
    {
      block: roomTurn ? null : 'room_tools',
      text: options.hostConnected ? buildRoomToolsBlock('') : '',
    },
    { block: null, text: blocked },
    {
      block: 'dorkos_tool_schemas',
      text: chatToolsLine(
        options.hostConnected,
        options.agentToAgent ?? false,
        visibility?.hiddenToolNames ?? new Set()
      ),
    },
    { block: null, text: options.opts?.systemPromptAppend ?? '' },
    ...(options.opts?.additionalContext ?? []).map((entry) => ({
      block: null,
      text: renderDoeContextEntry(entry),
    })),
  ];
  return parts.filter((part) => part.text !== '');
}

/** Every fresh turn receives current identity, SOUL and MemoryProvider snapshot exactly once. */
export async function buildDoeContext(options: DoeContextOptions): Promise<string> {
  return joinFitted(await buildDoeContextParts(options), []);
}
