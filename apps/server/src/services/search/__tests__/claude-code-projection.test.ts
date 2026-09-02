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

  it('still indexes a message that merely MENTIONS the kickoff tag', () => {
    // The envelope predicate needs BOTH anchors: quoting the tag is real speech.
    const projection = project([said('what does <dork-kickoff> mean in the source?')]);

    expect(projection.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        body: 'what does <dork-kickoff> mean in the source?',
      }),
    ]);
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

/**
 * The id a hit lands on (DOR-1579).
 *
 * Every case here is about one property: the id an indexed message carries is
 * the id `parseTranscript` gives the message the session view draws. Where the
 * two disagree the answer must be `null` — a miss opens the conversation, and an
 * id that names a DIFFERENT message would open the wrong one.
 */
describe('the id a Claude Code hit lands on', () => {
  /** A tool RESULT record — the `user`-role record between the halves of a turn. */
  function toolResult(uuid: string): string {
    return line({
      type: 'user',
      uuid,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
      },
    });
  }

  it('carries the record’s own uuid for what a person typed', () => {
    const projection = project([said('what about dogs', { uuid: 'u-1' })]);

    expect(projection.messages[0]?.messageId).toBe('u-1');
  });

  it('answers null for a record that carries no uuid, rather than inventing one', () => {
    // `parseTranscript` falls back to `crypto.randomUUID()`, which is a fresh id
    // on every parse. Copying that shape here would store an id that names
    // nothing and looks exactly like one that works.
    const projection = project([said('unidentified')]);

    expect(projection.messages[0]?.messageId).toBeNull();
  });

  it('gives every part of one assistant turn the id the turn is drawn under', () => {
    // The session view folds consecutive assistant records into ONE message and
    // keeps the LAST id (`mergeConsecutiveAssistantMessages`), while this indexes
    // each record that carries text. Red if a message keeps its own record's
    // uuid: the turn on screen is not addressable by it.
    const projection = project([
      said('go on', { uuid: 'u-1' }),
      answered([{ type: 'text', text: 'first I will look' }], { uuid: 'a-1' }),
      answered([{ type: 'tool_use', name: 'Read', id: 'call-1', input: {} }], { uuid: 'a-2' }),
      toolResult('r-1'),
      answered([{ type: 'text', text: 'and here is the answer' }], { uuid: 'a-3' }),
      answered([{ type: 'tool_use', name: 'Read', id: 'call-2', input: {} }], { uuid: 'a-4' }),
    ]);

    expect(projection.messages.map((message) => [message.body, message.messageId])).toEqual([
      ['go on', 'u-1'],
      ['first I will look', 'a-4'],
      ['and here is the answer', 'a-4'],
    ]);
  });

  it('does not read a task notification as the end of a turn', () => {
    // `parseTranscript` walks straight past a `<task-notification>` record, so
    // the assistant records either side of it are one message there. It is the
    // commonest record of any kind between the halves of a turn, so reading it
    // as a boundary costs most of the landings there are.
    const projection = project([
      answered([{ type: 'text', text: 'before' }], { uuid: 'a-1' }),
      said('<task-notification>a run finished</task-notification>', { uuid: 'n-1' }),
      answered([{ type: 'text', text: 'after' }], { uuid: 'a-2' }),
    ]);

    expect(projection.messages.map((message) => message.messageId)).toEqual(['a-2', 'a-2']);
  });

  it('reads what a person said as the end of the turn before it', () => {
    // The other direction, and the one that matters for correctness: a person
    // speaking DOES end the assistant turn there, so the two turns must not be
    // folded into one id — that would land a hit in the first turn on the
    // second one.
    const projection = project([
      answered([{ type: 'text', text: 'first turn' }], { uuid: 'a-1' }),
      said('and now something else', { uuid: 'u-1' }),
      answered([{ type: 'text', text: 'second turn' }], { uuid: 'a-2' }),
    ]);

    expect(projection.messages.map((message) => message.messageId)).toEqual(['a-1', 'u-1', 'a-2']);
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

  it('does not index a limit notice either', () => {
    const projection = project([
      apiError("You've hit your weekly limit · resets Aug 24 at 8pm", 'rate_limit', 'e-1'),
    ]);

    expect(projection.messages).toEqual([]);
  });

  // The notice is still an assistant record for run bookkeeping: the session
  // view folds it into the turn it interrupted and keeps the LAST uuid, so a
  // hit on that turn's real text must land on the notice's uuid.
  it('still closes the run whose id the session view will render', () => {
    const projection = project([
      answered([{ type: 'text', text: 'working on it' }], { uuid: 'a-1' }),
      apiError('API Error: 529 Overloaded.', 'server_error', 'e-1'),
    ]);

    expect(projection.messages.map((message) => [message.body, message.messageId])).toEqual([
      ['working on it', 'e-1'],
    ]);
  });

  it('keeps indexing an ordinary reply that merely mentions authentication', () => {
    const projection = project([
      answered([{ type: 'text', text: 'Your OAuth token expired, so I refreshed it.' }], {
        uuid: 'a-1',
      }),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual([
      'Your OAuth token expired, so I refreshed it.',
    ]);
  });
});
