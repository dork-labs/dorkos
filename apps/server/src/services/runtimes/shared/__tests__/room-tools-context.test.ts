/**
 * What the `<room_tools>` block promises.
 *
 * There was briefly a second block, for turns whose own words were posted for
 * them; there is one now (DOR-2099), and the sentences asserted here are the
 * ones DOR-1643's live DM probes showed were missing rather than merely worded
 * weakly: the model formed an answer, narrated it into a session nobody reads,
 * and spent the posting tool on a pleasantry.
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

describe('the room tools block', () => {
  const block = buildRoomToolsBlock(PREFIX);

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

describe('what the block says about a pinned document', () => {
  it('tells a turn that a pin is how a board stays put', () => {
    const block = buildRoomToolsBlock(PREFIX);
    expect(block).toContain('A pinned document stays on the table');
    // The board is the whole of D13's "documentation, not a primitive": the
    // teaching names it, and nothing in the schema does.
    expect(block).toContain('#team starts with one');
  });
});

describe('what the block says about the early signal (DOR-1975)', () => {
  // FB-10: an agent that takes a long turn leaves nothing on the message until
  // it finishes. Every assertion here reads the words with the line breaks
  // folded away, so a reflow cannot red a rule that is still stated.
  const block = buildRoomToolsBlock(PREFIX);

  it('signals BEFORE the long work, not after', () => {
    // The ordering word is the part that matters: the instruction is worthless
    // if the signal arrives with the result.
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain('BEFORE A LONG TURN, PUT 👀 ON THE MESSAGE THAT TRIGGERED YOU');
    expect(words).toContain('first, before the work');
  });

  it('forbids BOTH a reaction and an "on it" message for one trigger', () => {
    // The over-participation failure this rule has to not cause: two
    // acknowledgments of the same nothing is worse than the silence it fixes.
    expect(block.replace(/\s+/g, ' ')).toContain(
      'Never a reaction AND an "on it" message for the same trigger'
    );
  });

  it('swaps the 👀 for a ✅ when the work is done, and says what that ✅ means', () => {
    // Without the swap an agent leaves a room saying it is still working when
    // it is not; `on: false` is the mechanism, and naming it is what makes the
    // instruction actionable. And ✅ already means "seen" in the ack triple a
    // few lines up, so the text has to say which ✅ this is.
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain('take the 👀 off (on: false) and put ✅ on');
    expect(words).toContain('A ✅ that replaced your own 👀 means finished');
  });

  it('asks for no signal at all when the answer is coming in this turn', () => {
    // The bound. Without it "signal early" becomes a progress narration in emoji.
    expect(block.replace(/\s+/g, ' ')).toContain(
      'If the answer is coming in THIS turn, signal nothing; the answer is the acknowledgment'
    );
  });
});
