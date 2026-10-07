/**
 * `dorkos community` says it is experimental (DOR-2740): in its help, and on
 * stderr before a real run does anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMUNITY_DEPLOY_HELP,
  COMMUNITY_EXPERIMENTAL_NOTICE,
  runCommunityDispatcher,
} from '../community-dispatcher.js';

const context = {
  cliVersion: '0.0.0',
  dorkHome: '/nonexistent',
  processEnv: {},
  parseRelease: () => {
    throw new Error('not reached');
  },
};

afterEach(() => vi.restoreAllMocks());

describe('community command experimental notice', () => {
  it('opens the help with the notice', () => {
    expect(COMMUNITY_DEPLOY_HELP).toContain(COMMUNITY_EXPERIMENTAL_NOTICE.trim());
    expect(COMMUNITY_EXPERIMENTAL_NOTICE).toMatch(/^Experimental:/);
  });

  it('prints the notice to stderr before a deploy run, not to stdout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // A run missing its required choices stops right after the notice.
    await expect(runCommunityDispatcher(['deploy'], context)).rejects.toThrow();
    expect(stderr).toHaveBeenCalledWith(COMMUNITY_EXPERIMENTAL_NOTICE);
    expect(stdout).not.toHaveBeenCalledWith(COMMUNITY_EXPERIMENTAL_NOTICE);
  });

  it('prints it once, inside the help, for --help', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await expect(runCommunityDispatcher(['deploy', '--help'], context)).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(COMMUNITY_DEPLOY_HELP);
    expect(stderr).not.toHaveBeenCalledWith(COMMUNITY_EXPERIMENTAL_NOTICE);
  });
});
