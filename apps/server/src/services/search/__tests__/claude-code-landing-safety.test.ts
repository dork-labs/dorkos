import { describe, it, expect } from 'vitest';
import { projectClaudeCodeLines } from '../projections/claude-code.js';
import { parseTranscript } from '../../runtimes/claude-code/sessions/transcript-parser.js';

/**
 * The one property a wrong landing would break, checked against the real
 * session view rather than against a description of it (DOR-1579).
 *
 * The table test next door pins the ids the projection produces. This asks the
 * different question the projection's safety claim actually rests on: for every
 * indexed message that carries an id the session view KNOWS, is the message
 * drawn under that id the one holding the indexed text? A hit whose id matches
 * nothing is fine and expected — it opens the conversation. A hit whose id
 * matches a DIFFERENT message opens the wrong one, and no amount of the
 * projection agreeing with itself would catch that.
 *
 * So both sides run here, over shapes chosen because they are where the two
 * disagree: the projection folds an assistant turn to its closing record's
 * uuid, and `parseTranscript` folds one to its last EMITTED record's id. Every
 * record one of them skips and the other does not is a candidate divergence,
 * and this is the file that says which of them are safe.
 */

/** One JSONL line. */
const L = (record: unknown): string => JSON.stringify(record);

/** An assistant record with the given content blocks. */
const A = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  L({ type: 'assistant', uuid, message: { role: 'assistant', content }, ...extra });

/** A user record with the given content. */
const U = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  L({ type: 'user', uuid, message: { role: 'user', content }, ...extra });

const text = (t: string) => [{ type: 'text', text: t }];
const toolUse = (id: string) => [{ type: 'tool_use', name: 'Read', id, input: {} }];

/**
 * Every indexed message whose id names a message the session view does NOT draw
 * the indexed text under.
 *
 * Comparison is on whitespace-stripped containment in either direction, because
 * the two sides legitimately hold different text for the same record: a slash
 * command is indexed as the raw `<command-name>` record and drawn as `/context`.
 * What is being tested is which MESSAGE the id names, not how it is spelled.
 */
function misplaced(lines: string[]): string[] {
  const { messages } = projectClaudeCodeLines(lines, { originKey: 's', firstOrdinal: 0 });
  const rendered = parseTranscript(lines);
  const byId = new Map(rendered.map((message) => [message.id, message]));
  const strip = (value: string | undefined): string => (value ?? '').replace(/\s+/g, '');
  return messages.flatMap((message) => {
    if (message.messageId === null) return [];
    const target = byId.get(message.messageId);
    if (target === undefined) return [];
    const body = strip(message.body);
    const shown = [
      strip(target.content),
      ...(target.parts ?? []).map((part) => (part.type === 'text' ? strip(part.text) : '')),
    ];
    const found = shown.some(
      (candidate) =>
        candidate !== '' && (candidate.includes(body) || (body !== '' && body.includes(candidate)))
    );
    return found ? [] : [`${JSON.stringify(message.body)} -> ${message.messageId}`];
  });
}

describe('a Claude Code hit never lands on a different message', () => {
  it('holds when a task notification splits the two halves of a turn', () => {
    // The commonest record between the halves of an agentic turn, and the one
    // the fold exists for: the parser walks past it, so the assistant records
    // either side are ONE message there and must be one run here.
    expect(
      misplaced([
        A('a-1', text('before')),
        U('n-1', '<task-notification>a run finished</task-notification>'),
        A('a-2', toolUse('call-1')),
        U('u-1', 'thanks'),
      ])
    ).toEqual([]);
  });

  it('holds when the person speaks between two turns', () => {
    // The other direction: a person speaking really does split the turn, so
    // folding across it would land a hit in the first turn on the second.
    expect(
      misplaced([
        A('a-1', text('first turn')),
        U('u-1', 'and now something else'),
        A('a-2', text('second turn')),
        U('u-2', 'ok'),
      ])
    ).toEqual([]);
  });

  it('holds for the resume-bootstrap reply the session view never draws', () => {
    // The one shape that DID misplace a hit, found by running both sides over
    // 186 real transcripts. The parser skips this record outright; indexing its
    // text meant the run's closing uuid named a real turn that does not contain
    // it. Red if `isResumeBootstrapReply` is dropped.
    const lines = [
      U('m-1', 'Continue from where you left off.', { isMeta: true }),
      A('s-1', text('No response requested.'), { message: undefined }),
      A('a-1', text('the actual answer')),
      A('a-2', toolUse('call-1')),
      U('u-1', 'thanks'),
    ];
    // Rebuilt with the model field the CLI stamps, which is half the predicate.
    lines[1] = L({
      type: 'assistant',
      uuid: 's-1',
      message: { role: 'assistant', model: '<synthetic>', content: text('No response requested.') },
    });
    expect(misplaced(lines)).toEqual([]);
    const { messages } = projectClaudeCodeLines(lines, { originKey: 's', firstOrdinal: 0 });
    expect(messages.map((message) => message.body)).not.toContain('No response requested.');
  });

  it('holds when a tool result carries no tool_use_id', () => {
    // The parser keys "this record is the harness answering" off `tool_use_id`,
    // not off the block type, and emits the record's sibling text when it is
    // missing — which splits the turn. Red if this side checks only the type.
    expect(
      misplaced([
        A('a-1', text('first turn answer')),
        U('u-1', [
          { type: 'tool_result', content: 'ok' },
          { type: 'text', text: 'hello from the person' },
        ]),
        A('a-2', text('second turn answer')),
        U('u-2', 'ok'),
      ])
    ).toEqual([]);
  });

  it('holds for an isMeta record carrying a tool result while a command is pending', () => {
    // The parser's `isMeta` branch runs BEFORE it looks at the content, and
    // flushes a pending slash command into a bubble — splitting the turn from a
    // record whose content shape says "transparent". Red if `isMeta` is read
    // after the content shape here.
    expect(
      misplaced([
        A('a-1', text('answer one')),
        L({
          type: 'user',
          uuid: 'tr-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1' }] },
          toolUseResult: { commandName: 'foo' },
        }),
        L({
          type: 'user',
          uuid: 'meta-1',
          isMeta: true,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2' }] },
        }),
        A('a-2', text('answer two')),
        U('u-9', 'ok'),
      ])
    ).toEqual([]);
  });

  it('holds across compaction, local commands and unknown record kinds', () => {
    // A compaction summary and a local command's output are both drawn, so both
    // split the turn; `attachment` and the metadata kinds are drawn nowhere and
    // must not. All four in one transcript, because it is their INTERLEAVING
    // that the run tracker has to get right.
    expect(
      misplaced([
        A('a-1', text('before compaction')),
        L({ type: 'system', uuid: 'sys-1', subtype: 'compact_boundary', compactMetadata: {} }),
        U('c-1', 'This session is being continued from a previous conversation', {
          isCompactSummary: true,
        }),
        A('a-2', text('after compaction')),
        L({ type: 'attachment', uuid: 'at-1' }),
        L({ type: 'permission-mode', uuid: 'pm-1' }),
        A('a-3', text('after the attachments')),
        L({
          type: 'system',
          uuid: 'sys-2',
          subtype: 'local_command',
          content: '<local-command-stdout>output text</local-command-stdout>',
        }),
        A('a-4', text('after the command')),
        U('u-9', 'ok'),
      ])
    ).toEqual([]);
  });
});
