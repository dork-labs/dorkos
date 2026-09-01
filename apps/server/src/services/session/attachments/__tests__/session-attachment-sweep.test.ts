/**
 * @vitest-environment node
 *
 * The sweep is the answer to "who owns this directory". These cases pin that it
 * drops what is past the window, keeps what is not, and never throws at a
 * caller who has a request to serve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalSessionAttachmentStore } from '../local-session-attachment-store.js';
import {
  SESSION_ATTACHMENT_RETENTION_MS,
  sweepSessionAttachments,
} from '../session-attachment-sweep.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('sweepSessionAttachments', () => {
  let dorkHome: string;
  let store: LocalSessionAttachmentStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-sweep-'));
    store = new LocalSessionAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Backdate a stored file so the sweep sees it as old. */
  async function backdate(file: string, ageMs: number): Promise<void> {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }

  it('keeps a fresh image and drops one past the window', async () => {
    await store.put(SESSION, 'fresh', 'image/png', PNG);
    await store.put(SESSION, 'stale', 'image/png', PNG);
    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    await backdate(path.join(dir, 'stale.png'), SESSION_ATTACHMENT_RETENTION_MS + 60_000);

    const result = await sweepSessionAttachments({ dorkHome });

    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(await readdir(dir)).toEqual(['fresh.png']);
  });

  it('removes a directory it emptied', async () => {
    await store.put(SESSION, 'stale', 'image/png', PNG);
    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    await backdate(path.join(dir, 'stale.png'), SESSION_ATTACHMENT_RETENTION_MS + 60_000);

    await sweepSessionAttachments({ dorkHome });

    await expect(stat(dir)).rejects.toThrow();
  });

  it('leaves a directory that still holds images', async () => {
    await store.put(SESSION, 'fresh', 'image/png', PNG);

    await sweepSessionAttachments({ dorkHome });

    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    expect(await readdir(dir)).toEqual(['fresh.png']);
  });

  it('is a no-op on a fresh install with no sessions directory at all', async () => {
    await expect(sweepSessionAttachments({ dorkHome })).resolves.toEqual({ removed: 0, kept: 0 });
  });

  it('honours an injected clock, so the window is testable without waiting a quarter', async () => {
    await store.put(SESSION, 'one', 'image/png', PNG);

    const result = await sweepSessionAttachments({
      dorkHome,
      now: Date.now() + SESSION_ATTACHMENT_RETENTION_MS + 60_000,
    });

    expect(result.removed).toBe(1);
  });
});
