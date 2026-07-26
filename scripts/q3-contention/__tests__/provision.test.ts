import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { assertSafeRunRoot, buildCanaryMap } from '../provision.js';
import { planAgents } from '../plan.js';
import type { RunPaths } from '../provision.js';
import type { RunPlan } from '../plan.js';

const REPO_ROOT = '/Users/someone/code/dorkos';

describe('assertSafeRunRoot', () => {
  it('accepts a directory inside the OS temp dir', async () => {
    const safe = path.join(os.tmpdir(), 'dorkos-q3-arm1-x');
    await expect(assertSafeRunRoot(safe, REPO_ROOT)).resolves.toContain('dorkos-q3-arm1-x');
  });

  it('refuses a path outside the OS temp dir', async () => {
    await expect(assertSafeRunRoot('/var/data/q3', REPO_ROOT)).rejects.toThrow(
      /not inside the OS temp directory/
    );
  });

  it('refuses the real DorkOS home', async () => {
    await expect(
      assertSafeRunRoot(path.join(os.homedir(), '.dork', 'q3'), REPO_ROOT)
    ).rejects.toThrow(/REFUSING TO RUN/);
  });

  it('refuses a path inside the repo checkout', async () => {
    await expect(assertSafeRunRoot(path.join(REPO_ROOT, '.temp', 'q3'), REPO_ROOT)).rejects.toThrow(
      /REFUSING TO RUN/
    );
  });

  it('refuses the temp root itself', async () => {
    await expect(assertSafeRunRoot(os.tmpdir(), REPO_ROOT)).rejects.toThrow(
      /temp root itself|REFUSING TO RUN/
    );
  });

  it('refuses the home directory', async () => {
    await expect(assertSafeRunRoot(os.homedir(), REPO_ROOT)).rejects.toThrow(/REFUSING TO RUN/);
  });
});

/** Minimal paths stub — only the canary map is under test. */
function stubPaths(): RunPaths {
  return {
    runRoot: '/tmp/run',
    dorkHome: '/tmp/run/dork-home',
    baseRepo: '/tmp/run/trees/base',
    trees: { a: '/tmp/run/trees/a', b: '/tmp/run/trees/b' },
    canaries: { a: '/tmp/run/trees/a/q3-canary.log', b: '/tmp/run/trees/b/q3-canary.log' },
    outDir: '/tmp/out',
    runId: 'test',
  };
}

/** Minimal plan stub carrying only what buildCanaryMap reads. */
function stubPlan(arm: 1 | 2, agentCount: number): RunPlan {
  return {
    arm,
    testMode: true,
    runtime: 'test-mode',
    agents: planAgents(arm, agentCount),
    trees: arm === 1 ? ['a'] : ['a', 'b'],
    durationMs: 1000,
    tickMs: 100,
    port: 4371,
    minOverlapMs: 100,
    outDir: undefined,
    keepRunRoot: false,
    skipBuild: true,
  };
}

describe('buildCanaryMap', () => {
  it('points every vocabulary at the single shared canary in arm 1', () => {
    const map = JSON.parse(buildCanaryMap(stubPlan(1, 4), stubPaths())) as Record<string, string>;
    expect(new Set(Object.values(map))).toEqual(new Set(['/tmp/run/trees/a/q3-canary.log']));
    expect(Object.keys(map)).toHaveLength(4);
  });

  it('gives each tree its own canary in arm 2, so the control isolates tree sharing', () => {
    const map = JSON.parse(buildCanaryMap(stubPlan(2, 4), stubPaths())) as Record<string, string>;
    expect(map.cats).toBe('/tmp/run/trees/a/q3-canary.log');
    expect(map.dogs).toBe('/tmp/run/trees/b/q3-canary.log');
    expect(new Set(Object.values(map)).size).toBe(2);
  });
});
