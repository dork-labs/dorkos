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

  it('carries the four-rule working agreement for rooms with several agents (DOR-3400)', () => {
    // Oct 29's #dorkos burst: stale posts, echoes, unowned waits and OKs on files that
    // had since changed. Each rule here is one of those failures, stated where every
    // room turn reads it, with the re-read tool named under this runtime's prefix.
    expect(block).toContain('WORKING WITH OTHERS IN A ROOM');
    expect(block).toContain('react to their message rather than saying it again');
    expect(block).toContain(
      `Before you post, read what arrived since your turn began (${PREFIX}read_room_history)`
    );
    expect(block).toContain('A hand-off names one owner and a time');
    expect(block).toContain('An OK names exactly what it covers');
  });

  it('says a post carries no hold to its readers, and a direct message carries it (DOR-3440)', () => {
    // The PM's S3 ruling on #3280: a room post marks nothing for the other agents who read it,
    // since each runs at its own level (Dorian, Oct 30); a chat_send starts one agent's turn, so
    // the hold travels with it. Security checks the code against this wording. It names no chat
    // tool: this block reaches sessions the chat tools are gated away from.
    expect(block).toContain('Every agent that reads your post runs at its own level');
    expect(block).toContain('stays with you');
    expect(block).toContain('A direct message to one agent is different: it starts');
    expect(block).toContain('so the hold goes with it');
    expect(block).not.toContain('chat_send');
  });

  it('hands long work off rather than holding the room (FB-65)', () => {
    // The chat tools block says what a helper and a spin-off are; this is the one line
    // that tells a room turn to use them, so the room is not left waiting on it.
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain('Long work does not hold the room');
    expect(words).toContain('A few minutes of looking can go to a helper');
    expect(words).toContain('hand anything longer to a spin-off chat or another agent');
    expect(words).toContain('end the turn, and post again when they report');
  });

  it('tells every seat to stay responsive (DOR-4081)', () => {
    // Responsive rooms, slice 1: a person waited minutes for a seat that was busy doing the
    // work inside its room turn. One line per behaviour the spec names, folded into the
    // long-work rule rather than added as a heading of its own (design pass v1, row 11).
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain('STAY RESPONSIVE.');
    expect(words).toContain('A short question gets a 1–2 sentence answer now.');
    expect(words).toContain(
      "Before anything bigger, post one line: what you're doing and who has it."
    );
    expect(words).toContain('never do it inside a room turn');
    expect(words).toContain('say who has it, end the turn, and post again when they report');
    expect(words).toContain('When nobody asked you and you hold nothing new, stay silent.');
    // Folded in, not duplicated: the old bullet is gone rather than left beside the new one.
    expect(words.match(/Long work does not hold the room/g)).toHaveLength(1);
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

  it('says the room puts the 👀 on for the agent, and the agent cannot', () => {
    // DOR-2823: the early signal is now the room's receipt, written the moment
    // the agent is picked, so the teaching must stop asking the agent for it.
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain(
      "DORKOS PUTS 👀 ON A PERSON'S MESSAGE FOR YOU the moment you are picked to answer it"
    );
    expect(words).toContain('you cannot use 👀 yourself');
    expect(words).not.toContain('PUT 👀 ON THE MESSAGE THAT TRIGGERED YOU');
  });

  it('forbids BOTH a reaction and an "on it" message for one trigger', () => {
    // The over-participation failure this rule has to not cause: two
    // acknowledgments of the same nothing is worse than the silence it fixes.
    expect(block.replace(/\s+/g, ' ')).toContain(
      'Never a reaction AND an "on it" message for the same trigger'
    );
  });

  it('offers a ✅ for finished work, and never asks the agent to take a 👀 off', () => {
    // The room takes its own receipt off when the turn ends (DOR-2823), so the
    // old "swap the 👀 for a ✅" step would ask for a reaction the agent cannot
    // make. ✅ already means "seen" a few lines up, so the text says which ✅.
    const words = block.replace(/\s+/g, ' ');
    expect(words).toContain(
      'After a long piece of work, you may put ✅ on the message to say it is finished'
    );
    expect(words).not.toContain('take the 👀 off');
  });

  it('asks for no signal at all when the answer is coming in this turn', () => {
    // The bound. Without it "signal early" becomes a progress narration in emoji.
    expect(block.replace(/\s+/g, ' ')).toContain(
      'If the answer is coming in THIS turn, signal nothing more; the answer is the acknowledgment'
    );
  });
});

describe('what the block says about a page that talks back (DOR-3159)', () => {
  const words = buildRoomToolsBlock(PREFIX).replace(/\s+/g, ' ');

  it('names every doc-channel tool, so a new one without a line fails here', async () => {
    // Read off the real capability builders, never a list kept here: a sixth
    // doc-channel tool registered tomorrow is red until the block teaches it.
    const { createDocChannelGrantCapabilities } =
      await import('../../../canvas/doc-channel/grant-capabilities.js');
    const { createDocChannelDownstreamCapabilities } =
      await import('../../../canvas/doc-channel/downstream/capabilities.js');
    const tools = [
      ...createDocChannelGrantCapabilities(),
      ...createDocChannelDownstreamCapabilities(),
    ].flatMap((capability) => capability.surfaces.mcp?.toolName ?? []);
    expect(tools.length).toBeGreaterThanOrEqual(5);
    const missing = tools.filter((tool) => !words.includes(`${PREFIX}${tool}`));
    expect(missing, 'doc-channel tools the agent is never told about').toEqual([]);
  });

  it('teaches routes, approval, the widget events, bind and the room limit', () => {
    expect(words).toContain('A PAGE THAT TALKS BACK.');
    expect(words).toContain('channel: { routes }');
    expect(words).toContain('"log" | "agent:owner" | "room:self" | "agent:<id>"');
    expect(words).toContain('A person allows routes from the Routes button');
    expect(words).toContain('Change a route and it needs allowing again.');
    expect(words).toContain('arrives as widget.action with payload.actionId');
    expect(words).toContain('{ kind: "emit", type } sends a type of your own');
    expect(words).toContain('bind: { path }');
    expect(words).toContain("On a ROOM canvas, routed events don't start your turn yet.");
    expect(words).toContain('Only a person can pin a document');
    expect(words).toContain('only when the Docs experiment is on');
  });
});
