/**
 * What a run says about the asks nobody was there to answer.
 *
 * The instant refusal a scheduled run makes is only an improvement on the ten
 * minutes it replaces if the person reading the run in the morning is told what
 * was skipped. These pin the telling — and, just as much, pin that the sentence
 * is not applied to denials a person would have had no say in either.
 */
import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '../schemas.js';
import {
  createRefusedAskLog,
  describeRefusedAsks,
  NO_APPROVAL_SURFACE,
  readableToolName,
  withRefusedAsks,
} from '../run-refusals.js';

/** DorkOS's own refusal record for an ask nobody could answer. */
function nobodyThere(toolName: string, id = `t-${toolName}`): StreamEvent {
  return {
    type: 'permission_denied',
    data: {
      toolCallId: id,
      toolName,
      reasonType: NO_APPROVAL_SURFACE,
      reason: 'nobody was available to approve this tool',
      message: 'Nobody is available to approve this on a scheduled run.',
    },
  } as StreamEvent;
}

/** A denial the runtime made on its own, which a person would not have changed. */
function runtimeDenial(toolName: string, reasonType: string): StreamEvent {
  return {
    type: 'permission_denied',
    data: { toolCallId: `r-${toolName}`, toolName, reasonType, message: 'no' },
  } as StreamEvent;
}

describe('readableToolName', () => {
  it("drops the dorkos server's prefix, because it names plumbing", () => {
    expect(readableToolName('mcp__dorkos__post_to_room')).toBe('post_to_room');
  });

  it('keeps any other server, because two servers can expose the same tool', () => {
    expect(readableToolName('mcp__linear__search')).toBe('linear: search');
    expect(readableToolName('mcp__notion__search')).toBe('notion: search');
  });

  it('leaves a plain tool name alone', () => {
    expect(readableToolName('Bash')).toBe('Bash');
  });
});

describe('describeRefusedAsks', () => {
  it('says nothing when nothing was refused', () => {
    expect(describeRefusedAsks([])).toBeNull();
  });

  it('names the one tool', () => {
    expect(describeRefusedAsks(['Bash'])).toBe(
      'Skipped Bash — nobody was there to approve it on a scheduled run.'
    );
  });

  it('names every tool, once each, in the order they were refused', () => {
    // Plural, because two tools are not an "it".
    expect(describeRefusedAsks(['Bash', 'WebFetch', 'Bash'])).toBe(
      'Skipped Bash and WebFetch — nobody was there to approve them on a scheduled run.'
    );
  });

  it('counts the rest past five, so the line cannot crowd out the run summary', () => {
    // The line leads a 500-character field. An agent that reached for thirty
    // things it could not have must not push its own words out of the row.
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(describeRefusedAsks(many)).toBe(
      'Skipped a, b, c, d and e and 2 more — nobody was there to approve them on a scheduled run.'
    );
  });
});

describe('createRefusedAskLog', () => {
  it("records only DorkOS's own nobody-was-there refusals", () => {
    // A safety-classifier or deny-rule denial would have gone the same way with
    // a person sitting right there, so describing one as "nobody was there to
    // approve it" would be false. The stamp is what keeps the sentence true.
    const log = createRefusedAskLog();
    log.observe(runtimeDenial('Bash', 'classifier'));
    log.observe(runtimeDenial('WebFetch', 'rule'));
    log.observe(nobodyThere('mcp__dorkos__control_ui'));

    expect(log.all()).toEqual([
      {
        toolName: 'mcp__dorkos__control_ui',
        reason: 'nobody was available to approve this tool',
      },
    ]);
    expect(log.summaryLine()).toBe(
      'Skipped control_ui — nobody was there to approve it on a scheduled run.'
    );
  });

  it('records one entry per tool however many times it is retried', () => {
    // An agent in a retry loop produces one refusal per attempt. Thirty rows
    // saying the same thing bury everything else in the feed.
    const log = createRefusedAskLog();
    const events = Array.from({ length: 30 }, (_, i) => nobodyThere('Bash', `t-${i}`));
    const answers = events.map((event) => log.observe(event));

    expect(log.all()).toHaveLength(1);
    // Only the FIRST attempt is answered — the other 29 are the same fact again,
    // and the caller writes one activity row per answer it gets.
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(answers[0]).toEqual({
      toolName: 'Bash',
      reason: 'nobody was available to approve this tool',
    });
  });

  it('answers the first refusal of a tool, and nothing else', () => {
    const log = createRefusedAskLog();

    expect(log.observe(nobodyThere('Bash', 't-1'))).toMatchObject({ toolName: 'Bash' });
    expect(log.observe(nobodyThere('Bash', 't-2'))).toBeUndefined();
    expect(log.observe(nobodyThere('WebFetch'))).toMatchObject({ toolName: 'WebFetch' });
    expect(
      log.observe({ type: 'text_delta', data: { text: 'working' } } as StreamEvent)
    ).toBeUndefined();
  });

  it('ignores a refusal the runtime could not name a tool for', () => {
    const log = createRefusedAskLog();
    log.observe({
      type: 'permission_denied',
      data: { toolCallId: 't1', reasonType: NO_APPROVAL_SURFACE, message: 'x' },
    } as StreamEvent);

    expect(log.all()).toEqual([]);
    expect(log.summaryLine()).toBeNull();
  });

  it('says nothing for a run that was refused nothing', () => {
    const log = createRefusedAskLog();
    log.observe({ type: 'text_delta', data: { text: 'all done' } } as StreamEvent);
    expect(log.summaryLine()).toBeNull();
  });
});

describe('withRefusedAsks', () => {
  it('leads with the refusals, because every reader quotes the first line', () => {
    expect(withRefusedAsks('Skipped Bash.', 'I checked the deps.')).toBe(
      'Skipped Bash.\nI checked the deps.'
    );
  });

  it('is the whole summary when the run produced no output of its own', () => {
    expect(withRefusedAsks('Skipped Bash.', '')).toBe('Skipped Bash.');
  });

  it('leaves the summary of a clean run exactly as it was', () => {
    expect(withRefusedAsks(null, 'I checked the deps.')).toBe('I checked the deps.');
  });
});
