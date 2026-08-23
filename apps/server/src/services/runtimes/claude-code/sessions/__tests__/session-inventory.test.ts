import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { inventorySessionIds } from '../session-inventory.js';

/**
 * The fleet-wide session roll call (DOR-1436).
 *
 * Its caller deletes durable rows on the strength of an id being ABSENT, so
 * both halves of the answer are load-bearing: an inventory that quietly misses a
 * project makes every live session in it look deleted.
 *
 * Real directories on the real filesystem — the thing under test is what
 * `readdir` says about a tree, which a mocked `fs` would only restate.
 */
describe('inventorySessionIds', () => {
  let tmp: string;
  let accountA: string;
  let accountB: string;

  /** Write an empty transcript file for `sessionId` in one account's project. */
  async function seed(account: string, slug: string, sessionId: string): Promise<void> {
    const slugDir = join(account, 'projects', slug);
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${sessionId}.jsonl`), '');
  }

  /** Both accounts' projects roots, as the transcript reader would hand them over. */
  function roots(): string[] {
    return [join(accountA, 'projects'), join(accountB, 'projects')];
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'session-inventory-'));
    accountA = join(tmp, 'claude-active');
    accountB = join(tmp, '.claude');
    await mkdir(join(accountA, 'projects'), { recursive: true });
    await mkdir(join(accountB, 'projects'), { recursive: true });
  });

  afterEach(async () => {
    await chmod(join(accountA, 'projects', 'locked'), 0o755).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  });

  it('collects every project of every account, not just one', async () => {
    // The whole reason this exists rather than a per-project listing: a session
    // belonging to another project is absent from that project's list, and the
    // caller reads absence as "deleted".
    await seed(accountA, '-Users-me-alpha', 'aaaa-1');
    await seed(accountA, '-Users-me-beta', 'aaaa-2');
    await seed(accountB, '-Users-me-gamma', 'bbbb-1');

    const { ids, complete } = await inventorySessionIds(roots());

    expect(complete).toBe(true);
    expect([...ids].sort()).toEqual(['aaaa-1', 'aaaa-2', 'bbbb-1']);
  });

  it('counts only transcripts, never the files beside them', async () => {
    await seed(accountA, '-Users-me-alpha', 'aaaa-1');
    await writeFile(join(accountA, 'projects', '-Users-me-alpha', 'notes.txt'), '');
    await writeFile(join(accountA, 'projects', 'stray.jsonl'), '');

    const { ids } = await inventorySessionIds(roots());

    expect([...ids]).toEqual(['aaaa-1']);
  });

  it('is complete and empty when the accounts hold no projects at all', async () => {
    const { ids, complete } = await inventorySessionIds(roots());

    expect(complete).toBe(true);
    expect(ids.size).toBe(0);
  });

  it('refuses to call an empty root set an empty machine', async () => {
    // No account resolved. From here that is indistinguishable between "Claude
    // Code has never run" and "the config directory moved" — and only one of
    // those is safe to delete rows on, so neither is.
    const { ids, complete } = await inventorySessionIds([]);

    expect(complete).toBe(false);
    expect(ids.size).toBe(0);
  });

  it('follows a symlinked project directory instead of dropping it', async () => {
    // The reaper's worst case, and it is not hypothetical: `readdir` does not
    // follow symlinks, so a project directory reached through one reports
    // `isDirectory() === false`. Filtering on that skipped it WITHOUT marking
    // the inventory incomplete — a live, listable, resumable session missing
    // from a roll call that claimed to be complete, which is enough to delete
    // its queued words.
    const real = join(tmp, 'elsewhere', '-Users-me-alpha');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'live-session.jsonl'), '');
    await symlink(real, join(accountA, 'projects', '-Users-me-alpha'));

    const { ids, complete } = await inventorySessionIds(roots());

    expect([...ids]).toEqual(['live-session']);
    expect(complete).toBe(true);
  });

  it('passes over a dangling symlink without calling the inventory partial', async () => {
    // Its target is gone, so it cannot be hiding a transcript. Reporting it as
    // a failure would mean one stale link permanently disabling reclamation.
    await seed(accountA, '-Users-me-alpha', 'aaaa-1');
    await symlink(join(tmp, 'never-existed'), join(accountA, 'projects', 'dangling'));

    const { ids, complete } = await inventorySessionIds(roots());

    expect([...ids]).toEqual(['aaaa-1']);
    expect(complete).toBe(true);
  });

  it('passes over a FIFO the same way', async () => {
    await seed(accountA, '-Users-me-alpha', 'aaaa-1');
    execFileSync('mkfifo', [join(accountA, 'projects', 'pipe')]);

    const { ids, complete } = await inventorySessionIds(roots());

    expect([...ids]).toEqual(['aaaa-1']);
    expect(complete).toBe(true);
  });

  it('reports incomplete when an account cannot be read at all', async () => {
    await seed(accountA, '-Users-me-alpha', 'aaaa-1');

    const { ids, complete } = await inventorySessionIds([
      join(accountA, 'projects'),
      join(tmp, 'account-that-went-away', 'projects'),
    ]);

    expect(complete).toBe(false);
    expect([...ids]).toEqual(['aaaa-1']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports incomplete when a project directory cannot be read',
    async () => {
      // The mass false positive this guards: one unreadable directory makes
      // every session in it look deleted.
      await seed(accountA, '-Users-me-alpha', 'aaaa-1');
      await seed(accountA, 'locked', 'aaaa-2');
      await chmod(join(accountA, 'projects', 'locked'), 0o000);

      const { ids, complete } = await inventorySessionIds(roots());

      expect(complete).toBe(false);
      // What it DID read still comes back — the caller decides what an
      // incomplete answer is worth, and saying so is this function's job.
      expect([...ids]).toEqual(['aaaa-1']);
    }
  );
});
