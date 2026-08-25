import { describe, it, expect } from 'vitest';
import { projectClaudeCodeLines } from '../projections/claude-code.js';

/**
 * The projection is a pure function over lines, so this is a table test and not
 * an integration one. It has no filesystem, no database and no clock, which is
 * the property that keeps "adding a source" honest at one function.
 */

/** One JSONL line, as it appears on disk. */
function line(record: unknown): string {
  return JSON.stringify(record);
}

/** A user record a person wrote. */
function said(text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    timestamp: '2026-07-28T10:00:00.000Z',
    message: { role: 'user', content: text },
    ...extra,
  });
}

/** An assistant record with the given content blocks. */
function answered(content: unknown, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'assistant',
    timestamp: '2026-07-28T10:00:01.000Z',
    message: { role: 'assistant', content },
    ...extra,
  });
}

/** Project with the defaults every case here shares. */
function project(lines: string[], firstOrdinal = 0) {
  return projectClaudeCodeLines(lines, { originKey: 'session-1', firstOrdinal });
}

describe('projecting Claude Code transcripts', () => {
  it('keeps what a person and an agent said, in prose', () => {
    const projection = project([
      said('what did we decide about dogs'),
      answered([{ type: 'text', text: 'We decided to walk them.' }]),
    ]);

    expect(projection).toEqual({
      skipped: 0,
      messages: [
        {
          originKey: 'session-1',
          ordinal: 0,
          role: 'user',
          createdAt: '2026-07-28T10:00:00.000Z',
          body: 'what did we decide about dogs',
        },
        {
          originKey: 'session-1',
          ordinal: 1,
          role: 'assistant',
          createdAt: '2026-07-28T10:00:01.000Z',
          body: 'We decided to walk them.',
        },
      ],
    });
  });

  it('numbers messages from the ordinal it is handed, so an append never renumbers history', () => {
    const projection = project(
      [said('third thing'), answered([{ type: 'text', text: 'fourth' }])],
      2
    );

    expect(projection.messages.map((message) => message.ordinal)).toEqual([2, 3]);
  });

  it('drops a message with no text left after trimming', () => {
    const projection = project([said('   '), answered([{ type: 'text', text: '' }]), said('real')]);

    // Silently: nothing has drifted, there is simply nothing to search.
    expect(projection.skipped).toBe(0);
    expect(projection.messages.map((message) => message.body)).toEqual(['real']);
  });

  it('suppresses the sibling text of a tool_result-bearing user record', () => {
    // The harness answering the model, not the person. Any `text` block beside a
    // `tool_result` is SDK-internal — the same rule the renderer applies.
    const projection = project([
      line({
        type: 'user',
        timestamp: '2026-07-28T10:00:02.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'exit code 0' },
            { type: 'text', text: 'Continue with the next step.' },
          ],
        },
      }),
      said('and then?'),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['and then?']);
    expect(projection.skipped).toBe(0);
  });

  it('drops thinking and tool_use blocks while keeping the prose beside them', () => {
    const projection = project([
      answered([
        { type: 'thinking', thinking: 'the user probably means dogs', signature: 'abc' },
        { type: 'text', text: 'Here is the plan.' },
        { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
      ]),
    ]);

    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]?.body).toBe('Here is the plan.');
  });

  it('drops a reasoning-only record entirely', () => {
    const projection = project([
      answered([{ type: 'thinking', thinking: 'quietly', signature: 'abc' }]),
    ]);

    expect(projection).toEqual({ messages: [], skipped: 0 });
  });

  it('skips a malformed line, counts it, and carries on with the file', () => {
    const projection = project([
      said('before'),
      '{"type":"user","message":{"role":"user","content":"tor',
      said('after'),
    ]);

    // Counted, never thrown: one bad line must not cost a session. And never
    // silent: a source that stops contributing rows is otherwise
    // indistinguishable from a source with nothing new.
    expect(projection.skipped).toBe(1);
    expect(projection.messages.map((message) => message.body)).toEqual(['before', 'after']);
    expect(projection.messages.map((message) => message.ordinal)).toEqual([0, 1]);
  });

  it('counts a line that parses but carries no type', () => {
    const projection = project([
      line({ message: { role: 'user', content: 'orphan' } }),
      said('ok'),
    ]);

    expect(projection.skipped).toBe(1);
    expect(projection.messages.map((message) => message.body)).toEqual(['ok']);
  });

  it('ignores the record types that are not speech, without counting them', () => {
    const projection = project([
      line({ type: 'summary', summary: 'A chat about dogs' }),
      line({ type: 'file-history-snapshot', snapshot: { contents: 'const x = 1;' } }),
      line({ type: 'attachment', subtype: 'skill_listing', content: 'Skill: writing' }),
      line({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>ok' }),
      said('and the prose survives'),
    ]);

    expect(projection.skipped).toBe(0);
    expect(projection.messages.map((message) => message.body)).toEqual(['and the prose survives']);
  });

  it('drops a subagent turn on either role', () => {
    const projection = project([
      said("here is your subagent's prompt", { isSidechain: true }),
      answered([{ type: 'text', text: 'working on it' }], { isSidechain: true }),
      said('the real question'),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['the real question']);
  });

  it('drops CLI-internal records and the compaction summary nobody wrote', () => {
    const projection = project([
      said('<command-message>resume</command-message>', { isMeta: true }),
      said('This session is being continued from a previous conversation…', {
        isCompactSummary: true,
      }),
      answered([{ type: 'text', text: 'still here' }], { isMeta: true }),
      said('carry on'),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['carry on']);
  });

  it('strips the system-reminder plumbing wrapped around what a person typed', () => {
    const projection = project([said('<system-reminder>be nice</system-reminder>what about cats')]);

    expect(projection.messages[0]?.body).toBe('what about cats');
  });

  it('records no timestamp rather than inventing one', () => {
    const projection = project([
      line({ type: 'user', message: { role: 'user', content: 'undated' } }),
    ]);

    expect(projection.messages[0]?.createdAt).toBeNull();
  });
});
