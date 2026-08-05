import { describe, expect, it } from 'vitest';
import { assistantSaid } from '../run.js';

/**
 * The role filter in the multi-window check's runtime comparison.
 *
 * This exists because the check it backs is the one that catches "the agent
 * answered and the browser never showed it", and there are two ways to make it
 * certify nothing: match the marker in the user's own message (it always
 * contains it — the prompt says "reply with exactly {marker}"), or treat an
 * unreadable payload as agreement.
 */
describe('assistantSaid', () => {
  const MARKER = 'MW1X12345-REPLY';

  it('does not count the marker echoed in the user prompt that asked for it', () => {
    const body = {
      messages: [
        { role: 'user', content: `Reply with exactly this line and nothing else: ${MARKER}` },
      ],
    };
    expect(assistantSaid(body, MARKER)).toBe(false);
  });

  it('counts the marker when the agent actually said it', () => {
    const body = {
      messages: [
        { role: 'user', content: `Reply with exactly this line and nothing else: ${MARKER}` },
        { role: 'assistant', content: MARKER },
      ],
    };
    expect(assistantSaid(body, MARKER)).toBe(true);
  });

  it('finds the marker inside structured assistant content', () => {
    const body = {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: `${MARKER} done` }] }],
    };
    expect(assistantSaid(body, MARKER)).toBe(true);
  });

  it('reads a bare array, which the route also returns', () => {
    expect(assistantSaid([{ role: 'assistant', content: MARKER }], MARKER)).toBe(true);
  });

  it('says UNKNOWN rather than agreement when the payload is not a message list', () => {
    // The caller must fail on null. Returning false here would read as "the
    // agent never answered", which is a different and wrong claim.
    expect(assistantSaid({ error: 'Session not found' }, MARKER)).toBeNull();
    expect(assistantSaid(null, MARKER)).toBeNull();
    expect(assistantSaid('nonsense', MARKER)).toBeNull();
  });

  it('does not match a different window marker', () => {
    const body = { messages: [{ role: 'assistant', content: 'MW2X99999-REPLY' }] };
    expect(assistantSaid(body, MARKER)).toBe(false);
  });
});
