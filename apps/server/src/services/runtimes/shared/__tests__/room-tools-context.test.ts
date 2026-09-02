/**
 * What the `<room_tools>` block promises, per reply mode.
 *
 * The text-reply half is already pinned where it is rendered
 * (`claude-code/messaging/__tests__/context-builder-room-tools.test.ts`). What
 * had no test at all was the TOOL-ONLY half, which is the one the flip turns on
 * — and the sentences asserted here are the ones DOR-1643's live DM probes
 * showed were missing rather than merely worded weakly: the model formed an
 * answer, narrated it into a session nobody reads, and spent the posting tool on
 * a pleasantry.
 *
 * So these are behaviour assertions on prompt copy, and they are worth their
 * cost for a specific reason: the block is the only place the association
 * between having an answer and calling the tool can live, and a reword that
 * dropped it would otherwise be caught by nothing until the next paid eval run.
 */
import { describe, it, expect } from 'vitest';
import { buildRoomToolsBlock } from '../room-tools-context.js';

/** The prefix claude-code and codex both use, so the assertions read as a model sees them. */
const PREFIX = 'mcp__dorkos__';

describe('the tool-only room tools block', () => {
  const block = buildRoomToolsBlock(PREFIX, 'tool-only');

  it('says the answer the turn worked out is what goes in the tool call', () => {
    // The DOR-1643 inversion in one sentence: an agent that knows the tool is
    // "how you speak" can still decide it spoke by writing. This is the line
    // that closes it, and it has to name the argument the answer travels in.
    expect(block).toContain('THE ANSWER YOU WORK OUT THIS TURN GOES IN THE text ARGUMENT, IN FULL');
    expect(block).toContain('AND THE ANSWER YOU FORMED IS THE THING YOU POST');
    expect(block).toContain(`then call ${PREFIX}post_to_room with that answer as the text`);
  });

  it('rules a reaction out as a way of delivering an answer it has', () => {
    // The old text paired the obligation with the escape hatch in the same
    // breath ("Post, or react if that genuinely says it all"), which let a
    // gesture stand in for an answer that existed.
    expect(block).toContain(
      'A reaction is the alternative only when the message asked you NOTHING'
    );
    expect(block).toContain('it cannot deliver an answer: if you\nhave one, post it');
  });

  it('lets a bare thanks go unanswered in a direct message, not just in a channel', () => {
    // The restraint half of the same inversion. "Wrote to you in a direct
    // message -- answering is not optional" read as an instruction to reply to
    // "thanks!", which is what the live probe measured it doing.
    expect(block).toContain('in a direct\nmessage as much as in a channel');
    expect(block).toContain('"thanks", "got it", "nice one"');
  });

  it("still tells the truth about where a turn's own words go", () => {
    expect(block).toContain('Nothing you write back to your own session this turn is posted');
  });
});

describe('the text-reply room tools block', () => {
  const block = buildRoomToolsBlock(PREFIX);

  it('carries none of the tool-only association copy', () => {
    // The default path is unchanged by DOR-1643, and it must stay that way: in
    // text mode the turn's words ARE the message, so telling an agent its
    // answer only counts once it reaches a tool call would be false.
    expect(block).not.toContain('THE ANSWER YOU WORK OUT THIS TURN');
    expect(block).not.toContain('AND THE ANSWER YOU FORMED IS THE THING YOU POST');
    expect(block).toContain('there your reply is already the message');
  });
});
