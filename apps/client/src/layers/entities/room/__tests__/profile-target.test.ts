/**
 * The one rule four surfaces now share for "whose profile does this face open?"
 *
 * Kept as its own file because the rule is about ID SPACES, not about any one
 * surface: a mention pill, a message face, a member row and the presence strip
 * all ask it, and each of them holds a different half of the answer.
 */
import { describe, it, expect } from 'vitest';
import { profileMemberIdOf } from '../lib/profile-target';

const AGENT_MEMBER_ID = '01JROSTERIDFORTHISAGENT';

describe('profileMemberIdOf', () => {
  it('passes a person’s own author id through — their roster row IS their author row', () => {
    expect(profileMemberIdOf({ id: 'author-ana', kind: 'human' }, undefined)).toBe('author-ana');
  });

  it('ignores an agent id offered for a person', () => {
    // Nothing should ever pass one, and if something did, the person's own id
    // is still the right answer — there is no second id space for people.
    expect(profileMemberIdOf({ id: 'author-ana', kind: 'human' }, AGENT_MEMBER_ID)).toBe(
      'author-ana'
    );
  });

  it('takes an agent’s id from the caller, never from the author row', () => {
    expect(profileMemberIdOf({ id: 'author-warden', kind: 'agent' }, AGENT_MEMBER_ID)).toBe(
      AGENT_MEMBER_ID
    );
  });

  it('answers nothing for an agent the caller could not place', () => {
    // The failure this rule exists to prevent: falling back to the author id
    // would open a profile the roster does not hold, which reads as an empty
    // drawer rather than as an error.
    expect(profileMemberIdOf({ id: 'author-warden', kind: 'agent' }, undefined)).toBeUndefined();
  });

  it('answers nothing for the room’s own voice, offered id or not', () => {
    expect(profileMemberIdOf({ id: 'system', kind: 'system' }, undefined)).toBeUndefined();
    expect(profileMemberIdOf({ id: 'system', kind: 'system' }, AGENT_MEMBER_ID)).toBeUndefined();
  });
});
