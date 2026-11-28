/**
 * `ls-remote` keeps the real `GITHUB_TOKEN`, so it never runs in the server's
 * own working folder, a project whose `.git/config` an agent can write
 * (DOR-5481): it runs in a folder DorkOS just made, removed afterwards.
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as { args: readonly string[]; cwd: unknown }[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...call: Parameters<typeof actual.spawn>) => {
      const [, args, options] = call as unknown as [string, string[], { cwd?: unknown }];
      spawned.push({ args, cwd: options?.cwd });
      return actual.spawn(...call);
    },
  };
});

import { lookupRemoteRef } from '../git/git-tree.js';

describe('ls-remote’s working folder', () => {
  it('is never the server’s own, and is gone afterwards', async () => {
    // Refused by the transport allow-list before any network: only the start matters.
    await lookupRemoteRef('file:///nonexistent-fixture.git', 'main');
    const lsRemote = spawned.find((call) => call.args.includes('ls-remote'));
    expect(lsRemote).toBeDefined();
    const cwd = String(lsRemote!.cwd);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd.startsWith(fs.realpathSync(os.tmpdir())) || cwd.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(cwd)).toBe(false);
  });
});
