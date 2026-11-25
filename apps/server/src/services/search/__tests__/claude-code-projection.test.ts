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
  // The birth turn wears the person's role and reaches this projection intact:
  // `stripSystemTags` strips `<system-reminder>` and the eight `CONTEXT_TAG`
  // wrappers, and `dork-kickoff` is not one of them (DOR-1659).
  it('leaves the birth turn out — the kickoff is DorkOS asking, not the person', () => {
    const projection = project([
      said('<dork-kickoff>\nIntroduce yourself and offer a first action.\n</dork-kickoff>'),
      answered([{ type: 'text', text: "Hi — I'm Keeper." }]),
    ]);

    expect(projection.messages).toEqual([
      expect.objectContaining({ ordinal: 0, role: 'assistant', body: "Hi — I'm Keeper." }),
    ]);
    // Dropped as speech, not as a parse failure.
    expect(projection.skipped).toBe(0);
  });

  it('drops the kickoff even when DorkOS prepended a context block to it', () => {
    const projection = project([
      said(
        '<git_status>\nIs git repo: true\n</git_status>\n\n' +
          '<dork-kickoff>\nIntroduce yourself.\n</dork-kickoff>'
      ),
    ]);

    expect(projection.messages).toEqual([]);
  });

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
          messageId: null,
          role: 'user',
          createdAt: '2026-07-28T10:00:00.000Z',
          body: 'what did we decide about dogs',
        },
        {
          originKey: 'session-1',
          ordinal: 1,
          messageId: null,
          role: 'assistant',
          createdAt: '2026-07-28T10:00:01.000Z',
          body: 'We decided to walk them.',
        },
      ],
    });
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
});

/**
 * The id a hit lands on (DOR-1579).
 *
 * Every case here is about one property: the id an indexed message carries is
 * the id `parseTranscript` gives the message the session view draws. Where the
 * two disagree the answer must be `null` — a miss opens the conversation, and an
 * id that names a DIFFERENT message would open the wrong one.
 */
describe('the id a Claude Code hit lands on', () => {
  it('carries the record’s own uuid for what a person typed', () => {
    const projection = project([said('what about dogs', { uuid: 'u-1' })]);

    expect(projection.messages[0]?.messageId).toBe('u-1');
  });
});

describe('synthetic API-error notices are not speech (DOR-1649)', () => {
  /** The CLI's own record for a failure, both markers as it writes them. */
  function apiError(text: string, code: string, uuid: string): string {
    return line({
      type: 'assistant',
      uuid,
      timestamp: '2026-07-28T10:00:01.000Z',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
      isApiErrorMessage: true,
      error: code,
    });
  }

  it('does not index the CLI wording of an expired sign-in', () => {
    const projection = project([
      said('carry on', { uuid: 'u-1' }),
      apiError(
        'Failed to authenticate: OAuth session expired and could not be refreshed',
        'authentication_failed',
        'e-1'
      ),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['carry on']);
  });
});
