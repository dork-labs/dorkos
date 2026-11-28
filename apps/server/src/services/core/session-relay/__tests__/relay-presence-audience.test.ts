/**
 * @vitest-environment node
 *
 * Who hears the relay's presence on the global stream (spec
 * `computer-side-starts-alone` §5.12): the audience the space side hands over,
 * and, before it has, the operator alone. Never wider than the handed-over
 * rule: an agent hears nothing either way.
 */
import { describe, expect, it } from 'vitest';
import type { CallerPrincipal } from '../../../../lib/caller-principal.js';
import { operatorAudience } from '../../../notifications/notification-entitlement.js';
import { sessionRelayPresenceAudience, wireSessionRelay } from '../index.js';

const OPERATOR: CallerPrincipal = { kind: 'operator' };
const PROGRAM: CallerPrincipal = { kind: 'program', userId: 'user-1' };
const AGENT: CallerPrincipal = { kind: 'agent' };
const RELAYED: CallerPrincipal = { kind: 'relayed' };
const BRIDGED: CallerPrincipal = { kind: 'bridged', platform: 'telegram', platformUserId: 'u-1' };

/** The relay's other pieces, which this file does not read. */
const PIECES = {
  meshCore: () => undefined,
  origins: {},
  remoteAccessOn: () => false,
  handOverTurn: () => undefined,
};

describe('the relay presence audience', () => {
  it('reaches the operator alone before the space side hands its audience over', () => {
    expect(sessionRelayPresenceAudience(OPERATOR)).toBe(true);
    for (const principal of [PROGRAM, AGENT, RELAYED, BRIDGED]) {
      expect(sessionRelayPresenceAudience(principal), principal.kind).toBe(false);
    }
  });

  it('reaches the operator alone when the wiring hands no audience over', () => {
    wireSessionRelay(PIECES);
    expect(sessionRelayPresenceAudience(OPERATOR)).toBe(true);
    expect(sessionRelayPresenceAudience(PROGRAM)).toBe(false);
    expect(sessionRelayPresenceAudience(AGENT)).toBe(false);
  });

  it('answers as the handed-over audience once it is wired', () => {
    wireSessionRelay({ ...PIECES, ownerAudience: operatorAudience });
    for (const principal of [OPERATOR, PROGRAM, AGENT, RELAYED, BRIDGED]) {
      expect(sessionRelayPresenceAudience(principal), principal.kind).toBe(
        operatorAudience(principal)
      );
    }
    expect(sessionRelayPresenceAudience(AGENT)).toBe(false);
  });
});
