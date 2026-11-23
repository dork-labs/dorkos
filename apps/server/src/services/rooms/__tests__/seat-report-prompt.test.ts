/**
 * What a room seat is told when a spin-off's report wakes it (DOR-4469).
 *
 * The report is a private turn, so the only way it reaches the room is a post the seat
 * chooses to make. The old wording ("post only if the room needs to know") left every
 * report a candidate for a status post; the room now hears three kinds of project update,
 * and long work stays with its lead chat rather than resuming inside the seat.
 */
import { describe, expect, it } from 'vitest';
import { seatReportPrompt } from '../handoff/seat-report.js';

const prompt = seatReportPrompt({
  fromSessionId: 'spin-off-1',
  fromAgentPath: '/agents/builder',
  fromTitle: 'Fix the red build',
  text: 'PR #12 is green.',
}).replace(/\s+/g, ' ');

describe('the seat report prompt (DOR-4469)', () => {
  it('names the three project updates a room hears, and keeps answering questions', () => {
    expect(prompt).toContain(
      'Post there with post_to_room only when project work starts, is blocked on a person, or ships, or to answer someone who asked'
    );
    expect(prompt).toContain('A report is not room news by itself.');
    expect(prompt).not.toContain('only if the room needs to know');
  });

  it('says a result somebody in the room asked for is owed there, not held back', () => {
    expect(prompt).toContain(
      'A result somebody in the room asked for is owed there: post it now, never sit on it.'
    );
  });

  it('coordinates by chat_send and keeps long work with its lead', () => {
    expect(prompt).toContain('message the spin-off or the agent who must act with chat_send');
    expect(prompt).toContain('Long work stays with its lead chat, not this one.');
    expect(prompt).not.toContain('carry on with the work');
  });

  it('still says nobody in the room has seen the report, and fences it as data', () => {
    expect(prompt).toContain('Nobody in the room has seen this report.');
    expect(prompt).toContain('BEGIN SPIN-OFF REPORT');
    expect(prompt).toContain('PR #12 is green.');
  });
});
