import { describe, it, expect } from 'vitest';
import { projectCodexLines } from '../projections/codex.js';

/**
 * The projection is a pure function over lines, so this is a table test and not
 * an integration one — no filesystem, no database, no clock.
 *
 * The case that earns its place above all the others is the two-families one:
 * a rollout records the same message twice, once as a `response_item` and once
 * as an `event_msg`, and a projection reading both double-counts nearly every
 * message in the corpus while every other assertion here stays green.
 */

/** One JSONL line, as it appears on disk. */
function line(record: unknown): string {
  return JSON.stringify(record);
}

/** A `response_item` message record — the family this projection reads. */
function item(
  role: string,
  text: string,
  at = '2026-08-08T10:00:00.000Z',
  blockType = role === 'assistant' ? 'output_text' : 'input_text'
): string {
  return line({
    timestamp: at,
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: blockType, text }] },
  });
}

/** An `event_msg` record carrying the SAME message a second time. */
function event(type: 'user_message' | 'agent_message', message: string): string {
  return line({
    timestamp: '2026-08-08T10:00:00.000Z',
    type: 'event_msg',
    payload: { type, message },
  });
}

/** Project with the defaults every case here shares. */
function project(lines: string[], firstOrdinal = 0) {
  return projectCodexLines(lines, { originKey: 'session-1', firstOrdinal });
}

describe('projecting Codex rollouts', () => {
  it('keeps what a person and an agent said, in prose', () => {
    const projection = project([
      item('user', 'what did we decide about dogs'),
      item('assistant', 'We decided to walk them.', '2026-08-08T10:00:01.000Z'),
    ]);

    expect(projection).toEqual({
      skipped: 0,
      messages: [
        {
          originKey: 'session-1',
          ordinal: 0,
          messageId: null,
          role: 'user',
          createdAt: '2026-08-08T10:00:00.000Z',
          body: 'what did we decide about dogs',
        },
        {
          originKey: 'session-1',
          ordinal: 1,
          messageId: null,
          role: 'assistant',
          createdAt: '2026-08-08T10:00:01.000Z',
          body: 'We decided to walk them.',
        },
      ],
    });
  });

  it('reads ONE of the two families, so a message recorded twice is indexed once', () => {
    // THE test of this file. A rollout carries every message twice: the model's
    // own `response_item` and the CLI's `event_msg` feed. A projection reading
    // both returns four rows here and roughly double the corpus in production —
    // and nothing else in this suite would notice, because every other case
    // feeds it one family.
    const projection = project([
      item('user', 'why is the build slow'),
      event('user_message', 'why is the build slow'),
      item('assistant', 'Because the cache is cold.', '2026-08-08T10:00:01.000Z'),
      event('agent_message', 'Because the cache is cold.'),
    ]);

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages.map((message) => message.body)).toEqual([
      'why is the build slow',
      'Because the cache is cold.',
    ]);
    // Asserted rather than assumed: the two bodies must be the `response_item`
    // texts. A projection reading the `event_msg` family INSTEAD also produces
    // exactly two rows, so a count alone passes for it.
    expect(projection.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(projection.skipped).toBe(0);
  });

  it('numbers messages from the ordinal it is handed, so an append never renumbers history', () => {
    const projection = project([item('user', 'third thing'), item('assistant', 'fourth')], 2);

    expect(projection.messages.map((message) => message.ordinal)).toEqual([2, 3]);
  });

  it('drops everything that is not a message, silently', () => {
    // 82% of a rollout. Reasoning, tool calls, tool output, the per-turn context
    // record and the session header are not speech, and none of them is a
    // format drift worth counting.
    const projection = project([
      line({ timestamp: 'x', type: 'session_meta', payload: { id: 's', cwd: '/repo' } }),
      line({ timestamp: 'x', type: 'turn_context', payload: { cwd: '/repo' } }),
      line({
        timestamp: 'x',
        type: 'response_item',
        payload: { type: 'reasoning', summary: [], encrypted_content: 'zzz' },
      }),
      line({
        timestamp: 'x',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{}' },
      }),
      line({
        timestamp: 'x',
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'a stack trace nobody said' },
      }),
      line({ timestamp: 'x', type: 'world_state', payload: { full: true, state: {} } }),
      item('user', 'and this one is real'),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['and this one is real']);
    expect(projection.skipped).toBe(0);
  });

  it('drops the developer role, which is Codex talking to itself', () => {
    const projection = project([
      item('developer', '<skills_instructions>\n## Skills\nA skill is…\n</skills_instructions>'),
      item('user', 'ok'),
    ]);

    expect(projection.messages.map((message) => message.role)).toEqual(['user']);
    expect(projection.skipped).toBe(0);
  });

  it('keeps the words a person typed after the blocks DorkOS prepended to them', () => {
    // `codex/turn-input.ts` assembles a prompt as blocks joined by a blank line
    // with the person's words LAST, because Codex has no per-turn system
    // channel. Indexing the whole record would make every `<gen_ui>` teaching
    // block a message the person "sent".
    const projection = project([
      item(
        'user',
        '<gen_ui>\nDorkOS generative UI lets you render widgets.\n</gen_ui>\n\n' +
          '<git_status>\n{ "branch": "main" }\n</git_status>\n\n' +
          'Reply with exactly: ok'
      ),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['Reply with exactly: ok']);
  });

  it('drops a user record that is nothing but injected context', () => {
    const projection = project([
      item('user', '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
      item(
        'user',
        '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n# AGENTS.md\n</INSTRUCTIONS>'
      ),
      item('user', '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'),
      item('user', '<recommended_plugins>\n- Slack\n</recommended_plugins>'),
    ]);

    expect(projection.messages).toEqual([]);
    // Not `skipped`: these are records the projection read correctly and
    // decided against, which is the expected outcome rather than a drift.
    expect(projection.skipped).toBe(0);
  });

  it('leaves a tag a person typed inline alone', () => {
    // The gate keys on a block SHAPE — an opening tag with a newline after it —
    // precisely so that a message mentioning markup survives it.
    const projection = project([item('user', 'why does <div>x</div> not center?')]);

    expect(projection.messages.map((message) => message.body)).toEqual([
      'why does <div>x</div> not center?',
    ]);
  });

  it('drops a message that is nothing but pasted markup — the documented cost of the rule', () => {
    // Named as the trade it is rather than left to be discovered. Somebody who
    // pastes a block of HTML and types NOTHING else has that message indexed as
    // nothing, because the gate cannot tell their paste from the machine's own
    // block. The mitigation is the line below it: a single word of their own
    // and the whole message survives, paste included.
    const pasted = '<section>\n  <div class="card">unstyled</div>\n</section>';

    expect(project([item('user', pasted)]).messages).toEqual([]);
    expect(
      project([item('user', `${pasted}\n\nwhy is this not centered?`)]).messages.map(
        (message) => message.body
      )
    ).toEqual(['why is this not centered?']);
  });

  it('strips the blocks on a rollout written with CRLF line endings', () => {
    // The Windows build ships (alpha), and a `\n`-only rule would silently stop
    // stripping there — indexing every injected block as something the person
    // said, on one platform only.
    const projection = project([
      item('user', '<gen_ui>\r\nDorkOS generative UI…\r\n</gen_ui>\r\n\r\nReply with exactly: ok'),
    ]);

    expect(projection.messages.map((message) => message.body)).toEqual(['Reply with exactly: ok']);
  });

  it('leaves an UNTERMINATED opening tag alone rather than eating the message', () => {
    // Guessing wrong in this direction deletes what somebody wrote.
    const projection = project([item('user', '<thoughts>\nI think the cache is the problem')]);

    expect(projection.messages.map((message) => message.body)).toEqual([
      '<thoughts>\nI think the cache is the problem',
    ]);
  });

  it('drops a message with no text left after trimming', () => {
    const projection = project([item('assistant', '   \n  '), item('user', 'still here')]);

    expect(projection.messages.map((message) => message.body)).toEqual(['still here']);
    expect(projection.skipped).toBe(0);
  });

  it('counts a malformed line and keeps reading the file', () => {
    const projection = project([
      item('user', 'before the bad line'),
      '{"type":"response_item", this is not json',
      item('assistant', 'after the bad line'),
    ]);

    expect(projection.skipped).toBe(1);
    expect(projection.messages.map((message) => message.body)).toEqual([
      'before the bad line',
      'after the bad line',
    ]);
    // And the ordinals close over the gap rather than leaving a hole: they are
    // positions in the index, not line numbers.
    expect(projection.messages.map((message) => message.ordinal)).toEqual([0, 1]);
  });

  it('counts a line that parses but is not a record, and one whose content drifted', () => {
    // The quiet half of the format-change problem: a projection that returns
    // fewer rows is indistinguishable from a source with nothing to say, so
    // anything recognised as ours and unreadable has to be counted.
    const projection = project([
      line([1, 2, 3]),
      line({ timestamp: 'x', payload: {} }),
      line({
        timestamp: 'x',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'a bare string, not blocks' },
      }),
    ]);

    expect(projection.messages).toEqual([]);
    expect(projection.skipped).toBe(3);
  });

  it('records the timestamp verbatim, and null when there is none', () => {
    const projection = project([
      line({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      }),
    ]);

    expect(projection.messages[0]?.createdAt).toBeNull();
  });

  it('carries the response_item’s own id, and null when the record has none', () => {
    // Carried because it is the id Codex itself uses for the item — the SDK's
    // live event stream keys per-item state off the same field. Nothing lands on
    // it yet: the session view rebuilds a Codex conversation from DorkOS's own
    // event log, so `message-search-target.ts` keeps `codex` off its allowlist.
    // Red if the field is dropped, or if a missing one is filled in from
    // anywhere.
    const projection = project([
      line({
        timestamp: '2026-08-08T10:00:00.000Z',
        type: 'response_item',
        payload: {
          id: 'item_42',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'identified' }],
        },
      }),
      item('assistant', 'unidentified'),
    ]);

    expect(projection.messages.map((message) => message.messageId)).toEqual(['item_42', null]);
  });

  it('returns nothing at all for a rollout that holds only its header', () => {
    const projection = project([
      line({ timestamp: 'x', type: 'session_meta', payload: { id: 's-1', cwd: '/repo' } }),
    ]);

    expect(projection).toEqual({ messages: [], skipped: 0 });
  });
});
