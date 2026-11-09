/**
 * Where a scheduled run may stand (DOR-4060). Paths in a fixture home that is
 * never written to; HOME, DORK_HOME and CLAUDE_CONFIG_DIR point inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_RUN_HOME_MESSAGE, guardRunPlacement } from '../run-place-guard.js';

const HOME = '/fixture-4060/home';
const DORK = `${HOME}/.dork`;
const AGENT = `${HOME}/agents/qa`;

beforeEach(() => {
  vi.stubEnv('HOME', HOME);
  vi.stubEnv('DORK_HOME', DORK);
  vi.stubEnv('CLAUDE_CONFIG_DIR', `${HOME}/.claude-fixture`);
});
afterEach(() => vi.unstubAllEnvs());

describe("an agent's scheduled run", () => {
  it('runs in its own folder when the folder chain fell back to home', () => {
    expect(guardRunPlacement({ cwd: HOME, agentPath: AGENT })).toEqual({
      cwd: AGENT,
      agentPath: AGENT,
    });
  });

  it('keeps a folder the chain chose that is not protected', () => {
    const placement = { cwd: `${AGENT}/checkout`, agentPath: AGENT };
    expect(guardRunPlacement(placement)).toBe(placement);
  });
});

describe('a scheduled run with no agent', () => {
  it.each([HOME, '/fixture-4060', DORK, `${DORK}/relay`])('is refused in %s', (cwd) => {
    expect(() => guardRunPlacement({ cwd })).toThrow(GLOBAL_RUN_HOME_MESSAGE);
  });

  it('still runs in a folder that only holds the data folder, as a dev checkout does', () => {
    vi.stubEnv('DORK_HOME', '/fixture-4060/repo/apps/server/.temp/.dork');
    expect(guardRunPlacement({ cwd: '/fixture-4060/repo' })).toEqual({ cwd: '/fixture-4060/repo' });
  });

  it('says what to do in at most 15 words', () => {
    expect(GLOBAL_RUN_HOME_MESSAGE.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});
