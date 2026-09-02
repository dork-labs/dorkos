import { describe, it, expect } from 'vitest';
import {
  stripRelayContext,
  stripSystemTags,
  parseTranscript,
  buildCommandMessage,
  extractLocalCommandOutput,
  extractCommandMeta,
} from '../runtimes/claude-code/sessions/transcript-parser.js';
import { applyToolResult } from '../runtimes/claude-code/sessions/tool-result-outcome.js';
// These cases are about SHAPE — a typed error part instead of assistant text —
// so they ask for the auth copy rather than restating it, and a reword by the
// copy's owner leaves them alone. The sentence itself is pinned once, in
// `sdk/__tests__/api-error-record.test.ts`.
import { describeAssistantError } from '../runtimes/claude-code/sdk/sdk-error-mapping.js';
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

describe('parseTranscript skips DorkOS-steered corrective notes (DOR-1087)', () => {
  it('never renders a <dorkos-system-note> user message as a user bubble', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<dorkos-system-note>The tool call toolu_x was cancelled by the runtime, not by the user.</dorkos-system-note>',
        },
        uuid: 'msg-1',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'a real user message' },
        uuid: 'msg-2',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('a real user message');
  });
});

describe('parseTranscript keeps a seeded context out of the rendered user message', () => {
  // The transcript is the record a person reads back. `seedContext` is
  // background a CALLER attached to the turn — the model reads it, the person
  // never wrote it — so a transcript that shows it as the person's own words is
  // the failure this whole feature has to avoid. Shaped exactly as the JSONL
  // holds it: the adapter prepends the rendered block to the user content, and
  // the SDK persists the concatenation verbatim.
  const SEED = 'They arrived from the docs page for marketplace sources.';
  const TYPED = 'how do I add a source?';

  it('renders only the words the person typed', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: `<seed_context>\n${SEED}\n</seed_context>\n\n${TYPED}` },
        uuid: 'seeded-1',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe(TYPED);
    expect(result[0].content).not.toContain(SEED);
    expect(result[0].content).not.toContain('seed_context');
  });

  it('strips the seed when it rides alongside the other injected blocks', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            `<git_status>\nIs git repo: false\n</git_status>\n\n` +
            `<seed_context>\n${SEED}\n</seed_context>\n\n${TYPED}`,
        },
        uuid: 'seeded-2',
      }),
    ];
    expect(parseTranscript(lines)[0].content).toBe(TYPED);
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
    applyToolResult({ tc, resultText: 'output text' });
    expect(tc.result).toBe('output text');
  });

  it('sets result on ToolCallPart', () => {
    const tcPart: ToolCallPart = {
      type: 'tool_call',
      toolCallId: 'id-1',
      toolName: 'BashTool',
      status: 'complete',
    };
    applyToolResult({ tcPart, resultText: 'part output' });
    expect(tcPart.result).toBe('part output');
  });

  it('resolves AskUserQuestion answers via SDK answers on HistoryToolCall', () => {
    const tc: HistoryToolCall = {
      toolCallId: 'id-2',
      toolName: 'AskUserQuestion',
      status: 'complete',
      questions: [{ question: 'Proceed?', type: 'text' }],
    };
    applyToolResult({ tc, resultText: '', sdkAnswers: { 'Proceed?': 'yes' } });
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
    applyToolResult({ tc, resultText: '', sdkAnswers: { 'Proceed?': 'new-value' } });
    expect(tc.answers).toEqual({ '0': 'already-set' });
  });

  it('handles undefined tc and tcPart gracefully', () => {
    expect(() => applyToolResult({ resultText: 'result' })).not.toThrow();
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
        isApiErrorMessage: true,
        error: 'authentication_failed',
      }),
    ];
    const result = parseTranscript(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', messageType: 'compaction' });
    // Kept — but as the failure it is, not as a sentence the agent said.
    expect(result[1]).toMatchObject({ role: 'assistant' });
    expect(result[1].parts).toEqual([
      {
        type: 'error',
        message: describeAssistantError('authentication_failed'),
        category: 'auth_error',
        details: 'API Error: 401 Invalid authentication credentials',
      },
    ]);
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

describe('parseTranscript synthetic API-error notices (DOR-1649)', () => {
  /**
   * The record the CLI actually wrote when a turn's sign-in expired, copied
   * from the reported transcript (70fd483b…, CLI 2.1.224, 2026-09-01) and
   * trimmed to the fields the parser reads.
   */
  function authFailureRecord(): string {
    return JSON.stringify({
      parentUuid: '27a272f6-5858-4e8c-8746-5de8b94a6737',
      isSidechain: false,
      type: 'assistant',
      uuid: 'aae96903-ccea-4fdc-a73c-34116a710dd8',
      timestamp: '2026-09-01T12:06:43.988Z',
      message: {
        id: '4607c295-36fa-4b6a-8aef-9020980eaac8',
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        type: 'message',
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          {
            type: 'text',
            text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
          },
        ],
      },
      error: 'authentication_failed',
      isApiErrorMessage: true,
      userType: 'external',
      sessionId: '70fd483b-a826-4928-ae80-fb601b336426',
      version: '2.1.224',
    });
  }

  it('hydrates the reported auth failure as a typed error part, not assistant text', () => {
    const result = parseTranscript([authFailureRecord()]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'aae96903-ccea-4fdc-a73c-34116a710dd8',
      role: 'assistant',
      timestamp: '2026-09-01T12:06:43.988Z',
    });
    expect(result[0].parts).toEqual([
      {
        type: 'error',
        message: describeAssistantError('authentication_failed'),
        category: 'auth_error',
        details: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      },
    ]);
    // Nothing the agent "said": the vendor sentence must not come back as text.
    expect(result[0].content).toBe('');
    expect(result[0].parts?.some((p) => p.type === 'text')).toBe(false);
  });

  it('folds the notice into the turn it interrupted, keeping the real reply', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'real-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Working on it now.' }],
        },
      }),
      authFailureRecord(),
    ];

    const result = parseTranscript(lines);

    expect(result).toHaveLength(1);
    // The fold keeps the LAST record's id, so the merged turn is addressed by
    // the notice's uuid. The search projection's `closeAssistantRun` depends on
    // exactly this, so it is asserted on both sides.
    expect(result[0].id).toBe('aae96903-ccea-4fdc-a73c-34116a710dd8');
    expect(result[0].content).toBe('Working on it now.');
    expect(result[0].parts).toEqual([
      { type: 'text', text: 'Working on it now.' },
      {
        type: 'error',
        message: describeAssistantError('authentication_failed'),
        category: 'auth_error',
        details: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      },
    ]);
  });

  it('keeps the CLI wording for a limit notice DorkOS has no copy for', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'limit-1',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your weekly limit · resets Aug 24 at 8pm" }],
        },
        error: 'rate_limit',
        isApiErrorMessage: true,
      }),
    ];

    const result = parseTranscript(lines);

    expect(result[0].parts).toEqual([
      { type: 'error', message: "You've hit your weekly limit · resets Aug 24 at 8pm" },
    ]);
  });

  it('reads a notice whose content is a bare string', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'str-1',
        message: { role: 'assistant', content: 'API Error: Connection dropped (ECONNRESET)' },
        isApiErrorMessage: true,
      }),
    ];

    const result = parseTranscript(lines);

    expect(result[0].parts).toEqual([
      { type: 'error', message: 'API Error: Connection dropped (ECONNRESET)' },
    ]);
  });

  // Defensive, not observed: 0 of the 249 records measured carry a tool_use
  // block. If one ever does, the notice branch would render the notice and
  // nothing else, so it stands down and the record parses normally instead.
  // Losing a tool call is worse than the text reading as speech.
  it('stands down for a notice that also carries a tool call', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'mixed-1',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [
            { type: 'text', text: 'API Error: 500 Internal server error' },
            { type: 'tool_use', id: 'tool-9', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
        isApiErrorMessage: true,
        error: 'server_error',
      }),
    ];

    const result = parseTranscript(lines);

    expect(result[0].toolCalls).toHaveLength(1);
    expect(result[0].content).toBe('API Error: 500 Internal server error');
    expect(result[0].parts?.some((p) => p.type === 'error')).toBe(false);
  });

  it('falls back to the mapper sentence when the CLI wrote no text', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'blank-1',
        message: { role: 'assistant', model: '<synthetic>', content: [] },
        isApiErrorMessage: true,
        error: 'rate_limit',
      }),
    ];

    const result = parseTranscript(lines);

    // Never a blank card.
    expect(result[0].parts).toEqual([
      { type: 'error', message: 'The agent stopped with an unexpected error.' },
    ]);
  });

  // The inverse guard. Nothing about an ordinary reply may be reclassified —
  // not its text, not its tool calls, not a reply that merely talks about
  // authentication.
  it('never reclassifies an ordinary assistant message', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'ok-1',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Your OAuth token expired last week, so I refreshed it.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
      }),
    ];

    const result = parseTranscript(lines);

    expect(result[0].content).toBe('Your OAuth token expired last week, so I refreshed it.');
    expect(result[0].parts?.some((p) => p.type === 'error')).toBe(false);
    expect(result[0].toolCalls).toHaveLength(1);
  });

  it('still hides the resume bootstrap reply, which carries no error markers', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'synth-1',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      }),
    ];

    expect(parseTranscript(lines)).toHaveLength(0);
  });
});

describe('transcript parsing stays linear on hostile text (js/polynomial-redos)', () => {
  // Transcript text is a mix of what a person typed and what a tool printed,
  // and it lives in a file with no size cap. Three parsers here used regexes
  // that were quadratic when opening tags outnumbered closing ones, so a
  // pasted wall of markers made EVERY later render of that session slow.
  // Each case pins the answer AND the time.
  const budgetMs = 200;

  const timed = <T>(fn: () => T): { result: T; elapsed: number } => {
    const started = performance.now();
    const result = fn();
    return { result, elapsed: performance.now() - started };
  };

  it('strips system tags out of a wall of unclosed opens quickly', () => {
    const hostile = '<system-reminder>'.repeat(50_000);
    const { result, elapsed } = timed(() => stripSystemTags(hostile));
    expect(result).toBe(hostile);
    expect(elapsed).toBeLessThan(budgetMs);
  });

  it('reads command args out of a wall of unclosed opens quickly', () => {
    const hostile = `<command-name>/go</command-name>${'<command-args>'.repeat(50_000)}`;
    const { result, elapsed } = timed(() => extractCommandMeta(hostile));
    expect(result).toEqual({ commandName: '/go', commandArgs: '' });
    expect(elapsed).toBeLessThan(budgetMs);
  });

  it('reads local-command output out of a wall of unclosed opens quickly', () => {
    const hostile = '<local-command-stdout>'.repeat(50_000);
    const { result, elapsed } = timed(() => extractLocalCommandOutput(hostile));
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(budgetMs);
  });
});

describe('extractCommandMeta — behaviour preserved by the linear rewrite', () => {
  it('reads name and args out of a normal command record', () => {
    expect(
      extractCommandMeta('<command-name>/flow</command-name><command-args> verify </command-args>')
    ).toEqual({ commandName: '/flow', commandArgs: 'verify' });
  });

  it('returns empty args when the args block is absent', () => {
    expect(extractCommandMeta('<command-name>/flow</command-name>')).toEqual({
      commandName: '/flow',
      commandArgs: '',
    });
  });

  it('returns empty args when the args block is opened but never closed', () => {
    expect(extractCommandMeta('<command-name>/flow</command-name><command-args>oops')).toEqual({
      commandName: '/flow',
      commandArgs: '',
    });
  });

  it('takes the FIRST args block when several are present', () => {
    expect(
      extractCommandMeta(
        '<command-name>/flow</command-name><command-args>one</command-args><command-args>two</command-args>'
      )
    ).toEqual({ commandName: '/flow', commandArgs: 'one' });
  });

  it('returns null when there is no command name', () => {
    expect(extractCommandMeta('<command-args>orphan</command-args>')).toBeNull();
  });
});

describe('extractLocalCommandOutput — behaviour preserved by the linear rewrite', () => {
  it('keeps the LAST closing tag as the end of the body, as the greedy regex did', () => {
    expect(
      extractLocalCommandOutput(
        '<local-command-stdout>a</local-command-stdout>b</local-command-stdout>'
      )
    ).toBe('a</local-command-stdout>b');
  });

  it('reads the stream whose open tag comes FIRST, not stdout by default', () => {
    // The regex alternation matched at the leftmost position; a helper that
    // always checked stdout first would answer differently here.
    expect(
      extractLocalCommandOutput(
        '<local-command-stderr>err</local-command-stderr><local-command-stdout>out</local-command-stdout>'
      )
    ).toBe('err');
  });

  it('ignores a close tag that sits before its open', () => {
    expect(extractLocalCommandOutput('</local-command-stdout>x<local-command-stdout>y')).toBeNull();
  });

  it('falls through to stderr when stdout is opened but never closed', () => {
    expect(
      extractLocalCommandOutput(
        '<local-command-stdout>unclosed<local-command-stderr>err</local-command-stderr>'
      )
    ).toBe('err');
  });

  it('reads an empty body', () => {
    expect(extractLocalCommandOutput('<local-command-stdout></local-command-stdout>')).toBe('');
  });
});
