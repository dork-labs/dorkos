/**
 * The address rule (spec `profile-unification` §1.6).
 *
 * One `?profile=` link, two homes. The rule decides which one answers, and it
 * is written as a pure function because the docked home (W2.3) has to obey the
 * same sentence the sheet does.
 */
import { describe, it, expect } from 'vitest';
import { shouldDock } from '../model/profile-home';

describe('shouldDock', () => {
  it('docks the agent whose session you are already in', () => {
    // A sheet sliding over the conversation, to tell you about the agent you
    // are having it with, is the surface arguing with itself.
    expect(
      shouldDock('agent-warden', {
        pathname: '/session',
        sessionAgentMemberId: 'agent-warden',
      })
    ).toBe(true);
  });

  it('sheets a different agent, even inside a session', () => {
    expect(
      shouldDock('agent-scout', { pathname: '/session', sessionAgentMemberId: 'agent-warden' })
    ).toBe(false);
  });

  it('sheets everywhere that is not a session', () => {
    expect(
      shouldDock('agent-warden', { pathname: '/team', sessionAgentMemberId: 'agent-warden' })
    ).toBe(false);
  });

  it('sheets while the session’s agent is still unresolved', () => {
    // Docking on a guess would send the link to a panel that is about to show
    // somebody else.
    expect(shouldDock('agent-warden', { pathname: '/session', sessionAgentMemberId: null })).toBe(
      false
    );
  });
});
