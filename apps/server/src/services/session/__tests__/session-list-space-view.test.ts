/**
 * What the session-list stream reads from the space side (spec
 * `computer-side-starts-alone` §5.12): who may hear about a session, and a
 * folder's project. Before the view is handed over the stream is fail-closed:
 * the operator alone hears, and no project is guessed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
  sessionAudience,
} from '../../audit/session-visibility.js';
import {
  sessionListAudience,
  sessionListProjectOf,
  setSessionListSpaceView,
} from '../catalog/session-list-space-view.js';

const OPERATOR: CallerPrincipal = { kind: 'operator' };
const PROGRAM: CallerPrincipal = { kind: 'program', userId: 'user-1' };
const AGENT: CallerPrincipal = { kind: 'agent' };
const RELAYED: CallerPrincipal = { kind: 'relayed' };
const BRIDGED: CallerPrincipal = { kind: 'bridged', platform: 'slack', platformUserId: 'u-1' };
const EVERYONE = [OPERATOR, PROGRAM, AGENT, RELAYED, BRIDGED];
const AGENT_WORK = 'session-agent-work';

afterEach(() => {
  setSessionListSpaceView(undefined);
  resetSessionVisibility();
});

describe('the session-list space view', () => {
  it('lets the operator alone hear about any session before it is handed over', () => {
    // Agent work every member may read: the handed-over rule would let an agent hear it.
    initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
    const audience = sessionListAudience(AGENT_WORK);
    expect(audience(OPERATOR)).toBe(true);
    for (const principal of [PROGRAM, AGENT, RELAYED, BRIDGED]) {
      expect(audience(principal), principal.kind).toBe(false);
    }
  });

  it('guesses no project before it is handed over', () => {
    expect(sessionListProjectOf('/work/alpha')).toBeUndefined();
  });

  it('answers as the space side once handed over, and fails closed again when cleared', () => {
    initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
    setSessionListSpaceView({
      audience: sessionAudience,
      projectOf: (cwd) => (cwd === '/work/alpha' ? { root: '/work/alpha', name: 'alpha' } : null),
    });
    for (const principal of EVERYONE) {
      expect(sessionListAudience(AGENT_WORK)(principal), principal.kind).toBe(
        sessionAudience(AGENT_WORK)(principal)
      );
    }
    expect(sessionListAudience(AGENT_WORK)(AGENT)).toBe(true);
    expect(sessionListProjectOf('/work/alpha')).toEqual({ root: '/work/alpha', name: 'alpha' });
    expect(sessionListProjectOf('/work/plain')).toBeNull();

    setSessionListSpaceView(undefined);
    expect(sessionListAudience(AGENT_WORK)(AGENT)).toBe(false);
    expect(sessionListAudience(AGENT_WORK)(OPERATOR)).toBe(true);
  });

  it('never lets an agent hear about a person’s own chat, handed over or not', () => {
    initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'participants'] as const)));
    expect(sessionListAudience('own-chat')(AGENT)).toBe(false);
    setSessionListSpaceView({ audience: sessionAudience, projectOf: () => undefined });
    expect(sessionListAudience('own-chat')(AGENT)).toBe(false);
  });
});
