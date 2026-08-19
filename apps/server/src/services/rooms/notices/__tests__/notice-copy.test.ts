/**
 * What a room says about an agent that is waiting on a person.
 *
 * The notice is durable: somebody reads it whenever they next open the room,
 * which may be an hour later. So it must not promise anything the code will have
 * stopped doing by then. It used to end "it gives up if nobody does", read off a
 * ten-minute auto-deny; an agent now holds an unanswered prompt for four hours
 * (spec `ask-parks-on-timeout` §10), which made that clause a claim the product
 * no longer keeps.
 */
import { describe, it, expect } from 'vitest';
import { buildWaitingNotice, type WaitingKind } from '../notice-copy.js';

const KINDS: WaitingKind[] = ['approval', 'question', 'elicitation'];

describe('buildWaitingNotice', () => {
  it('never claims the agent gives up if nobody answers', () => {
    for (const kind of KINDS) {
      const { text } = buildWaitingNotice('Ana', 'author-ana', kind);
      expect(text).not.toContain('gives up');
      expect(text).toContain('It will wait, but not forever.');
    }
  });

  it('names the agent and where to answer, and nothing about the prompt itself', () => {
    // The notice reaches everybody in the room, so the tool name, the path and
    // the question stay in the session with the person who can act on them.
    const { text } = buildWaitingNotice('Ana', 'author-ana', 'approval');

    expect(text).toBe(
      "Ana is waiting for you to approve something before it can carry on. Open Ana's session to answer. It will wait, but not forever."
    );
  });

  it('carries no countdown, because a durable line cannot hold one honestly', () => {
    for (const kind of KINDS) {
      const { text } = buildWaitingNotice('Ana', 'author-ana', kind);
      expect(text).not.toMatch(/\d+\s*(minutes?|hours?)/);
    }
  });
});
