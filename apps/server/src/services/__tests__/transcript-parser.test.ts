import { describe, it, expect } from 'vitest';
import {
  stripRelayContext,
  stripSystemTags,
  parseTranscript,
  applyToolResult,
  buildCommandMessage,
  extractLocalCommandOutput,
} from '../runtimes/claude-code/sessions/transcript-parser.js';
import type { HistoryToolCall, ToolCallPart } from '@dorkos/shared/types';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { wrapKickoff } from '@dorkos/shared/kickoff';

describe('stripRelayContext', () => {
  it('returns original text when no relay_context prefix', () => {
    expect(stripRelayContext('Hello world')).toBe('Hello world');
  });

  it('returns user content after closing tag', () => {
    const text =
      '<relay_context>\nAgent-ID: abc\nSubject: test\n</relay_context>\n\nWrite a bubble sort';
    expect(stripRelayContext(text)).toBe('Write a bubble sort');
  });

  it('returns null for pure relay metadata (no content after closing tag)', () => {
    const text = '<relay_context>\nAgent-ID: abc\n</relay_context>';
    expect(stripRelayContext(text)).toBeNull();
  });

  it('returns null for malformed relay_context (no closing tag)', () => {
    const text = '<relay_context>\nAgent-ID: abc\nno closing tag';
    expect(stripRelayContext(text)).toBeNull();
  });

  it('handles multiple paragraphs of user content after closing tag', () => {
    const text = '<relay_context>\nAgent-ID: abc\n</relay_context>\n\nParagraph 1\n\nParagraph 2';
    expect(stripRelayContext(text)).toBe('Paragraph 1\n\nParagraph 2');
  });

  it('preserves command-like text after relay context', () => {
    const text = '<relay_context>\nAgent-ID: abc\n</relay_context>\n\n/help';
    expect(stripRelayContext(text)).toBe('/help');
  });
});

describe('stripSystemTags (CONTEXT_TAG-driven render guard, AC5)', () => {
  // Parametrized over CONTEXT_TAG so adding a ContextKind needs NO strip edit:
  // the strip and this test both iterate the same map.
  it.each(Object.values(CONTEXT_TAG))('strips an injected <%s> block from rendered text', (tag) => {
    const text = `before<${tag}>injected</${tag}>after`;
    expect(stripSystemTags(text)).toBe('beforeafter');
  });

  it('strips a <system-reminder> block', () => {
    expect(stripSystemTags('before<system-reminder>note</system-reminder>after')).toBe(
      'beforeafter'
    );
  });

  it('strips a multiline injected block (e.g. real git_status) leaving surrounding text', () => {
    const text = `Hi\n<${CONTEXT_TAG.git_status}>\nIs git repo: true\nCurrent branch: main\n</${CONTEXT_TAG.git_status}>\n\nWrite a test`;
    const result = stripSystemTags(text);
    expect(result).not.toContain('<git_status>');
    expect(result).not.toContain('Is git repo:');
    expect(result.startsWith('Hi')).toBe(true);
    expect(result.endsWith('Write a test')).toBe(true);
  });

  it('leaves text with no injected tags unchanged (trimmed)', () => {
    expect(stripSystemTags('  just user content  ')).toBe('just user content');
  });

  it('strips a <relay_context> block in place', () => {
    const text = `<${CONTEXT_TAG.relay_context}>\nAgent-ID: abc\n</${CONTEXT_TAG.relay_context}>\nhello`;
    expect(stripSystemTags(text)).toBe('hello');
  });
});

describe('parseTranscript relay context handling', () => {
  it('strips relay_context wrapper and preserves user content in history', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<relay_context>\nAgent-ID: 9c99edf1\nSubject: relay.agent.test\n</relay_context>\n\nWrite a JavaScript bubble sort function with comments',
        },
        uuid: 'msg-1',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Write a JavaScript bubble sort function with comments');
  });

  it('skips pure relay metadata with no user content', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: '<relay_context>\nAgent-ID: abc\n</relay_context>' },
        uuid: 'msg-1',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(0);
  });
});

// NOTE: the auto-first-turn kickoff (M4) is deliberately NOT suppressed here.
// The parser preserves it as an ordinary user record; the ONE runtime-agnostic
// suppression seam is `filterKickoffHistory` (@dorkos/shared/kickoff), applied
// at the server wire boundaries — see routes/__tests__/sessions-kickoff-filter.
describe('parseTranscript preserves the kickoff record for the route-level seam', () => {
  it('keeps a fenced kickoff user record intact (the route filters it, not the parser)', () => {
    const kickoff = wrapKickoff('Read your SOUL.md and introduce yourself.');
    const lines = [JSON.stringify({ type: 'user', message: { content: kickoff }, uuid: 'kick-1' })];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('<dork-kickoff>');
  });
});

describe('parseTranscript Skill tool_result suppression', () => {
  it('suppresses text blocks when tool_result is present in same message', () => {
    const lines = [
      // Assistant calls Skill tool
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Skill',
              input: { skill: 'test-skill', args: 'arg1' },
            },
          ],
        },
        uuid: 'msg-1',
      }),
      // User message with tool_result AND text blocks (SDK skill expansion)
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'skill output' },
            { type: 'text', text: 'Internal SDK skill expansion prompt that should not appear' },
          ],
        },
        uuid: 'msg-2',
      }),
    ];
    const result = parseTranscript(lines);
    // Should have assistant message with tool call, but NO user message for the expansion text
    const userMessages = result.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(0);
  });

  it('preserves Skill tool call card after tool_result suppression', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Skill',
              input: { skill: 'test-skill' },
            },
          ],
        },
        uuid: 'msg-1',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'skill output' },
            { type: 'text', text: 'expansion text' },
          ],
        },
        uuid: 'msg-2',
      }),
    ];
    const result = parseTranscript(lines);
    const assistantMsg = result.find((m) => m.role === 'assistant');
    expect(assistantMsg?.toolCalls).toBeDefined();
    expect(assistantMsg!.toolCalls![0].toolName).toBe('Skill');
    expect(assistantMsg!.toolCalls![0].result).toBe('skill output');
  });

  it('handles multiple tool_result blocks in single user message', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'ToolA', input: {} },
            { type: 'tool_use', id: 'tool-2', name: 'ToolB', input: {} },
          ],
        },
        uuid: 'msg-1',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'result A' },
            { type: 'tool_result', tool_use_id: 'tool-2', content: 'result B' },
            { type: 'text', text: 'should be suppressed' },
          ],
        },
        uuid: 'msg-2',
      }),
    ];
    const result = parseTranscript(lines);
    const userMessages = result.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(0);
  });
});

describe('parseTranscript AskUserQuestion answer normalization', () => {
  it('normalizes question-text-keyed tool_use answers to index-keyed (reload path)', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-q',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  { question: 'What size?', header: 'Size', multiSelect: false, options: [] },
                  {
                    question: 'Which toppings?',
                    header: 'Toppings',
                    multiSelect: true,
                    options: [],
                  },
                ],
                answers: { 'What size?': 'Large', 'Which toppings?': 'Cheese, Onion' },
              },
            },
          ],
        },
        uuid: 'msg-1',
      }),
    ];
    const result = parseTranscript(lines);
    const assistantMsg = result.find((m) => m.role === 'assistant');
    const part = assistantMsg!.parts!.find((p) => p.type === 'tool_call') as ToolCallPart;
    expect(part.answers).toEqual({ '0': 'Large', '1': 'Cheese, Onion' });
    expect(assistantMsg!.toolCalls![0].answers).toEqual({ '0': 'Large', '1': 'Cheese, Onion' });
  });

  it('tolerates legacy index-keyed tool_use answers', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-q',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  { question: 'What size?', header: 'Size', multiSelect: false, options: [] },
                ],
                answers: { '0': 'Large' },
              },
            },
          ],
        },
        uuid: 'msg-1',
      }),
    ];
    const result = parseTranscript(lines);
    const assistantMsg = result.find((m) => m.role === 'assistant');
    expect(assistantMsg!.toolCalls![0].answers).toEqual({ '0': 'Large' });
  });
});

describe('applyToolResult', () => {
  it('sets result on HistoryToolCall', () => {
    const tc: HistoryToolCall = { toolCallId: 'id-1', toolName: 'BashTool', status: 'complete' };
    applyToolResult(tc, undefined, 'output text', undefined);
    expect(tc.result).toBe('output text');
  });

  it('sets result on ToolCallPart', () => {
    const tcPart: ToolCallPart = {
      type: 'tool_call',
      toolCallId: 'id-1',
      toolName: 'BashTool',
      status: 'complete',
    };
    applyToolResult(undefined, tcPart, 'part output', undefined);
    expect(tcPart.result).toBe('part output');
  });

  it('resolves AskUserQuestion answers via SDK answers on HistoryToolCall', () => {
    const tc: HistoryToolCall = {
      toolCallId: 'id-2',
      toolName: 'AskUserQuestion',
      status: 'complete',
      questions: [{ question: 'Proceed?', type: 'text' }],
    };
    const sdkAnswers = { 'Proceed?': 'yes' };
    applyToolResult(tc, undefined, '', sdkAnswers);
    expect(tc.answers).toEqual({ '0': 'yes' });
  });

  it('does not overwrite existing answers on AskUserQuestion', () => {
    const tc: HistoryToolCall = {
      toolCallId: 'id-3',
      toolName: 'AskUserQuestion',
      status: 'complete',
      questions: [{ question: 'Proceed?', type: 'text' }],
      answers: { '0': 'already-set' },
    };
    applyToolResult(tc, undefined, '', { 'Proceed?': 'new-value' });
    expect(tc.answers).toEqual({ '0': 'already-set' });
  });

  it('handles undefined tc and tcPart gracefully', () => {
    expect(() => applyToolResult(undefined, undefined, 'result', undefined)).not.toThrow();
  });
});

describe('buildCommandMessage', () => {
  it('builds a command message with args', () => {
    const msg = buildCommandMessage('/test', 'arg1', 'uuid-1');
    expect(msg).toEqual({
      id: 'uuid-1',
      role: 'user',
      content: '/test arg1',
      messageType: 'command',
      commandName: '/test',
      commandArgs: 'arg1',
    });
  });

  it('builds a command message without args', () => {
    const msg = buildCommandMessage('/help', '', 'uuid-2');
    expect(msg).toEqual({
      id: 'uuid-2',
      role: 'user',
      content: '/help',
      messageType: 'command',
      commandName: '/help',
      commandArgs: undefined,
    });
  });

  it('generates a random UUID when none provided', () => {
    const msg = buildCommandMessage('/test', '');
    expect(msg.id).toBeTruthy();
    expect(typeof msg.id).toBe('string');
  });
});

describe('parseTranscript error/subagent extraction', () => {
  it('extracts error blocks from JSONL as ErrorPart', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Attempting to run...' },
            {
              type: 'error',
              message: 'Hook validation failed',
              category: 'execution_error',
            },
          ],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    const errorPart = messages[0].parts!.find((p) => p.type === 'error');
    expect(errorPart).toEqual({
      type: 'error',
      message: 'Hook validation failed',
      category: 'execution_error',
      details: undefined,
    });
  });

  it('extracts subagent blocks from JSONL as BackgroundTaskPart', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-2',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'subagent',
              task_id: 'task-abc',
              description: 'Running tests',
              status: 'complete',
              tool_uses: 3,
              last_tool_name: 'Bash',
              duration_ms: 5000,
              summary: 'All tests passed',
            },
          ],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(1);
    const taskPart = messages[0].parts!.find((p) => p.type === 'background_task');
    expect(taskPart).toEqual({
      type: 'background_task',
      taskId: 'task-abc',
      taskType: 'agent',
      status: 'complete',
      startedAt: 0,
      description: 'Running tests',
      toolUses: 3,
      lastToolName: 'Bash',
      durationMs: 5000,
      summary: 'All tests passed',
    });
  });

  it('preserves existing text/thinking/tool_use extraction alongside new types', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-4',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'Here is the result' },
            { type: 'error', message: 'Non-fatal issue' },
          ],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(3);
    expect(messages[0].parts![0].type).toBe('thinking');
    expect(messages[0].parts![1].type).toBe('text');
    expect(messages[0].parts![2].type).toBe('error');
  });

  it('handles missing optional fields with safe defaults', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-5',
        message: {
          role: 'assistant',
          content: [{ type: 'error' }, { type: 'subagent' }],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    const errorPart = messages[0].parts![0];
    expect(errorPart).toMatchObject({ type: 'error', message: '' });
    const subPart = messages[0].parts![1];
    expect(subPart).toMatchObject({
      type: 'background_task',
      taskId: '',
      taskType: 'agent',
      description: '',
      status: 'running',
    });
  });

  it('extracts error details when present', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-6',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'error',
              message: 'Budget exceeded',
              category: 'budget_exceeded',
              details: 'Used 150% of allocated tokens',
            },
          ],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    const errorPart = messages[0].parts!.find((p) => p.type === 'error');
    expect(errorPart).toEqual({
      type: 'error',
      message: 'Budget exceeded',
      category: 'budget_exceeded',
      details: 'Used 150% of allocated tokens',
    });
  });

  it('uses task_id for subagent taskId, falling back to id', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'msg-7',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'subagent',
              id: 'fallback-id',
              description: 'Test task',
              status: 'running',
            },
          ],
        },
      }),
    ];
    const messages = parseTranscript(lines);
    const subPart = messages[0].parts!.find((p) => p.type === 'background_task');
    expect(subPart).toMatchObject({ type: 'background_task', taskId: 'fallback-id' });
  });
});

describe('parseTranscript synthetic CLI record suppression', () => {
  // The CLI writes a resume bootstrap pair on every `query({resume})` turn
  // DorkOS triggers: an isMeta user record ("Continue from where you left
  // off.") followed by a zero-token synthetic assistant reply ("No response
  // requested."). The CLI hides both in its own UI; DorkOS must too —
  // operators reported them rendering as messages they never sent.
  it('hides the resume bootstrap pair (isMeta user + synthetic assistant)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        uuid: 'meta-1',
        message: { role: 'user', content: 'Continue from where you left off.' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'synth-1',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'real-1',
        message: { role: 'user', content: 'does the CLI support multiple accounts?' },
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: 'does the CLI support multiple accounts?',
    });
  });

  it('hides isMeta prompt expansions and caveats regardless of content shape', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: local commands</local-command-caveat>',
        },
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '# Git Commit\n\nStage and commit changes...' }],
        },
      }),
    ];
    expect(parseTranscript(lines)).toHaveLength(0);
  });

  it('still flushes a pending slash command when its expansion record is isMeta', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-message>commit</command-message><command-name>/git:commit</command-name>',
        },
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        uuid: 'expansion-1',
        message: { role: 'user', content: '# Git Commit\n\nStage and commit changes...' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'real-2',
        message: { role: 'user', content: 'now push it' },
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'command',
      commandName: '/git:commit',
      id: 'expansion-1',
    });
    // The real user message that follows must NOT be swallowed by the flush.
    expect(result[1]).toMatchObject({ role: 'user', content: 'now push it' });
  });

  it('keeps compaction summaries (not isMeta) and synthetic API error notices', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation...',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: 401 Invalid authentication credentials' }],
        },
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', messageType: 'compaction' });
    expect(result[1]).toMatchObject({
      role: 'assistant',
      content: 'API Error: 401 Invalid authentication credentials',
    });
  });

  it('attaches compact_boundary metadata to the following compaction summary (DOR-118)', () => {
    // Mirrors the real transcript ordering: the system/compact_boundary record
    // (carrying compactMetadata, camelCase on disk) immediately precedes the
    // isCompactSummary user record. The metadata is hoisted onto the row.
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'manual', preTokens: 50115, durationMs: 35623 },
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation...',
        },
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'compaction',
      compactMetadata: { trigger: 'manual', preTokens: 50115, durationMs: 35623 },
    });
  });

  it('renders a compaction summary with no boundary record as a bare row (DOR-118)', () => {
    // Older transcripts (or a dropped boundary record) still yield a compaction
    // row — just without token/trigger metadata.
    const lines = [
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued...' },
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: 'user', messageType: 'compaction' });
    expect(result[0].compactMetadata).toBeUndefined();
  });
});

describe('extractLocalCommandOutput', () => {
  it('extracts stdout wrapper inner text', () => {
    expect(extractLocalCommandOutput('<local-command-stdout>hi there</local-command-stdout>')).toBe(
      'hi there'
    );
  });

  it('extracts stderr wrapper inner text', () => {
    expect(
      extractLocalCommandOutput('<local-command-stderr>Error: boom</local-command-stderr>')
    ).toBe('Error: boom');
  });

  it('preserves multi-line / ANSI inner content', () => {
    const ansi = '\x1b[32mContext\x1b[0m\nLine 2';
    expect(extractLocalCommandOutput(`<local-command-stdout>${ansi}</local-command-stdout>`)).toBe(
      ansi
    );
  });

  it('returns null for a caveat record (not stdout/stderr)', () => {
    expect(
      extractLocalCommandOutput('<local-command-caveat>Caveat: heads up</local-command-caveat>')
    ).toBeNull();
  });

  it('returns null for non-wrapper content', () => {
    expect(extractLocalCommandOutput('just some text')).toBeNull();
  });
});

describe('parseTranscript local_command output (DOR-126)', () => {
  it('renders a system/local_command stdout record below its command bubble', () => {
    // Purely-local commands (e.g. /rename) record both the invocation and its
    // output as system/local_command records.
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'cmd-rename',
        content:
          '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>my-session</command-args>',
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'out-rename',
        content: '<local-command-stdout>Session renamed to: my-session</local-command-stdout>',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'command',
      commandName: '/rename',
      commandArgs: 'my-session',
      id: 'cmd-rename',
    });
    expect(result[1]).toMatchObject({
      role: 'user',
      messageType: 'local_command_output',
      content: 'Session renamed to: my-session',
      id: 'out-rename',
    });
  });

  it('flushes a deferred command bubble (user record) before its output, with distinct ids', () => {
    // Commands like /context record their <command-name> as a user record, then
    // their output as a following system/local_command record.
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'cmd-context',
        message: { role: 'user', content: '<command-name>/context</command-name>' },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'out-context',
        content: '<local-command-stdout>Context: 12,345 tokens (6%)</local-command-stdout>',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'command',
      commandName: '/context',
      id: 'cmd-context',
    });
    expect(result[1]).toMatchObject({
      role: 'user',
      messageType: 'local_command_output',
      content: 'Context: 12,345 tokens (6%)',
      id: 'out-context',
    });
  });

  it('renders stderr output (e.g. a failed /compact)', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'out-err',
        content: '<local-command-stderr>Error during compaction: ECONNRESET</local-command-stderr>',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'local_command_output',
      content: 'Error during compaction: ECONNRESET',
    });
  });

  it('skips empty local-command output (e.g. /clear)', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'out-empty',
        content: '<local-command-stdout></local-command-stdout>',
      }),
    ];
    expect(parseTranscript(lines)).toHaveLength(0);
  });

  it('skips a local_command caveat record', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'caveat-1',
        content: '<local-command-caveat>Caveat: heads up</local-command-caveat>',
      }),
    ];
    expect(parseTranscript(lines)).toHaveLength(0);
  });

  it('renders orphan output (no preceding command) as a standalone message', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 'orphan-out',
        content: '<local-command-stdout>stray output</local-command-stdout>',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      messageType: 'local_command_output',
      content: 'stray output',
      id: 'orphan-out',
    });
  });
});
