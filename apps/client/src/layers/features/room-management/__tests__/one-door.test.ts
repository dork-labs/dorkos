/**
 * The picker rule: one agent opens a session, two or more start a group message
 * (`sidebar-simplification` D2).
 *
 * @module features/room-management/__tests__/one-door
 */
import { describe, expect, it } from 'vitest';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { ONE_DOOR_HINT, oneDoorSubmitLabel, opensAgentSession } from '../lib/one-door';

/**
 * One agent as the picker holds it.
 *
 * @param displayName - What it is called on screen.
 */
function candidate(displayName: string): AgentPickerCandidate {
  return {
    agentPath: `/agents/${displayName.toLowerCase()}`,
    displayName,
    visual: null,
    description: null,
  };
}

describe('one door to an agent', () => {
  it('opens a session for exactly one agent', () => {
    expect(opensAgentSession([candidate('Ana')])).toBe(true);
  });

  it('makes a room for two or more', () => {
    expect(opensAgentSession([candidate('Ana'), candidate('Kai')])).toBe(false);
    expect(opensAgentSession([candidate('Ana'), candidate('Kai'), candidate('Bo')])).toBe(false);
  });

  it('makes neither out of nothing', () => {
    // The button is disabled at zero, so this answer is only ever read to decide
    // that nothing happens. "Would open a session with nobody" would be worse.
    expect(opensAgentSession([])).toBe(false);
  });

  it('names the agent it is about', () => {
    expect(oneDoorSubmitLabel([candidate('Ana')])).toBe('Open session with Ana');
  });

  it('says what two or more will make', () => {
    expect(oneDoorSubmitLabel([candidate('Ana'), candidate('Kai')])).toBe('Start group message');
  });

  it('says the same thing the label and the destination say', () => {
    // The hint is the rule stated in advance; a hint that disagreed with the
    // button under it would be worse than no hint at all.
    expect(ONE_DOOR_HINT).toBe('One agent opens a session. Two or more start a group message.');
  });
});
