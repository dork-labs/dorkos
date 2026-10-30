/**
 * The upgrade's pin of the repos DorkOS already knew (DOR-3298): once ever,
 * so a repo first seen later waits for a person. Real git, in temp repos.
 *
 * @vitest-environment node
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const store = vi.hoisted(() => ({ harness: {} as Record<string, unknown> }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'harness' ? store.harness : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'harness') store.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import { pinKnownRepoBaselinesOnce } from '../pin-repo-baselines.js';
import { resolveRepoBaseline } from '../repo-baseline.js';
import { isolateGitEnv, makeRepo, type RepoFixture } from './git-fixture.js';

const DORK_HOME = '/nonexistent-dork-home';
let known: RepoFixture;
let later: RepoFixture;
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = isolateGitEnv();
  store.harness = {};
  known = makeRepo({ '.claude/hooks/guard.sh': 'exit 0\n' });
  later = makeRepo({ '.claude/hooks/guard.sh': 'exit 0\n' });
});

afterEach(() => {
  known.cleanup();
  later.cleanup();
  restoreEnv();
});

describe('pinning the repos DorkOS already knew', () => {
  it('pins each known repo once, and never a repo first seen after', async () => {
    const plain = path.join(known.root, 'not-a-repo');
    expect(await pinKnownRepoBaselinesOnce(async () => [known.main, known.main, plain])).toBe(1);
    expect(store.harness.repoBaselinesPinned).toBe(true);
    const wt = known.addWorktree('wt');
    expect((await resolveRepoBaseline(wt, DORK_HOME)).untrusted).toBeUndefined();

    // A later start, with a repo an agent registered since: nothing is pinned.
    expect(await pinKnownRepoBaselinesOnce(async () => [later.main])).toBe(0);
    expect((await resolveRepoBaseline(later.main, DORK_HOME)).untrusted).toBe('first-seen');
  });

  it('pins nothing, ever, when the list cannot be read', async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error('registry not ready');
    };
    expect(await pinKnownRepoBaselinesOnce(failing)).toBe(0);
    expect(store.harness.repoBaselinesPinned).toBe(true);
    // A later start does not pin what was registered in between.
    expect(await pinKnownRepoBaselinesOnce(async () => [known.main])).toBe(0);
    expect((await resolveRepoBaseline(known.main, DORK_HOME)).untrusted).toBe('first-seen');
  });
});
