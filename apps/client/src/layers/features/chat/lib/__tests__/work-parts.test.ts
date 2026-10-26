/**
 * What a DM folds behind "Show work" and what it keeps in the conversation
 * (DOR-3075), pinned for every kind of part a reply can carry. A new part type
 * fails the exhaustiveness check below until somebody decides which side it is.
 */
import { describe, it, expect } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { countWorkSteps, hasWork, isWorkPart } from '../work-parts';

type Tool = Extract<MessagePart, { type: 'tool_call' }>;
const tool = (over: Partial<Tool> = {}): Tool => ({
  type: 'tool_call',
  toolCallId: 't',
  toolName: 'Read',
  input: '{}',
  status: 'complete',
  ...over,
});

/** Every part, by name, and whether it is work. */
const TABLE: Array<[string, MessagePart, boolean]> = [
  ['text', { type: 'text', text: 'Done.' }, false],
  ['image', { type: 'image', attachmentId: 'a', mediaType: 'image/png' } as MessagePart, false],
  ['thinking', { type: 'thinking', text: 'Hmm' }, true],
  ['memory_recall', { type: 'memory_recall', mode: 'select', memories: [] } as MessagePart, true],
  [
    'background_task (subagent)',
    {
      type: 'background_task',
      taskId: 'b',
      taskType: 'agent',
      status: 'running',
      startedAt: 0,
      description: 'x',
    } as MessagePart,
    true,
  ],
  ['plain tool call', tool(), true],
  ['todo list', tool({ toolName: 'TodoWrite' }), true],
  ['pending approval', tool({ interactiveType: 'approval', status: 'pending' }), false],
  ['answered approval', tool({ interactiveType: 'approval', status: 'complete' }), false],
  [
    'question (AskUserQuestion)',
    tool({ toolName: 'AskUserQuestion', interactiveType: 'question' }),
    false,
  ],
  ['request for an app', tool({ toolName: 'mcp__dorkos__connectors_request_connection' }), false],
  ['message to another chat (Sent card)', tool({ toolName: 'mcp__dorkos__chat_send' }), false],
  [
    'tool that draws an MCP App',
    tool({
      toolName: 'mcp__charts__plot',
      ui: { resourceUri: 'ui://charts/plot' },
    } as Partial<Tool>),
    false,
  ],
  [
    'elicitation',
    {
      type: 'elicitation',
      interactionId: 'e',
      serverName: 's',
      message: 'm',
      status: 'pending',
    } as MessagePart,
    false,
  ],
  ['capability_approval', { type: 'capability_approval', approval: {} } as MessagePart, false],
  ['mcp_signin', { type: 'mcp_signin', agentId: 'a', flowId: 'f' } as MessagePart, false],
  ['error', { type: 'error', message: 'Could not reach GitHub' }, false],
  [
    'permission_denied',
    { type: 'permission_denied', toolCallId: 't', toolName: 'Bash' } as MessagePart,
    false,
  ],
  [
    'model_substituted',
    { type: 'model_substituted', fromName: 'a', toName: 'b' } as MessagePart,
    false,
  ],
  [
    'work_left_running',
    { type: 'work_left_running', tasks: [{ taskId: 't', command: 'sleep 9' }] } as MessagePart,
    false,
  ],
  ['compact_boundary', { type: 'compact_boundary', trigger: 'auto' } as MessagePart, false],
];

describe('isWorkPart', () => {
  it.each(TABLE)('%s', (_name, part, work) => {
    expect(isWorkPart(part)).toBe(work);
  });

  it('covers every part type there is', () => {
    const covered = new Set(TABLE.map(([, part]) => part.type));
    const every: Record<MessagePart['type'], true> = {
      text: true,
      image: true,
      tool_call: true,
      background_task: true,
      thinking: true,
      error: true,
      elicitation: true,
      capability_approval: true,
      mcp_signin: true,
      memory_recall: true,
      permission_denied: true,
      model_substituted: true,
      work_left_running: true,
      compact_boundary: true,
    };
    expect([...covered].sort()).toEqual(Object.keys(every).sort());
  });
});

describe('countWorkSteps', () => {
  it('counts tool calls and subagents, never thinking or what stays in the chat', () => {
    const parts = TABLE.map(([, part]) => part);
    // plain tool call, todo list, subagent.
    expect(countWorkSteps(parts)).toBe(3);
    expect(hasWork(parts)).toBe(true);
    expect(hasWork([{ type: 'text', text: 'hi' }])).toBe(false);
  });
});
