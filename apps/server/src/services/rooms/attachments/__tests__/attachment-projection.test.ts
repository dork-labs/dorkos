/**
 * Putting a room's files inside the agent's own working directory.
 *
 * Over a REAL temp filesystem, because every failure mode this module has is a
 * filesystem failure mode: a hardlink that silently became a copy, a second run
 * that re-copied everything, a sweep that deleted a directory somebody was
 * still reading. None of those are observable through a mock.
 *
 * The load-bearing assertion is `nlink`. A copy and a link are indistinguishable
 * by content — both leave the right bytes at the right path — so a test that
 * only read the file back would pass just as happily against an implementation
 * that copied every large attachment on every turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import type { ProjectableAttachment } from '../../room-context.js';
import type { RoomAttachmentStore } from '../room-attachment-store.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../attachment-paths.js';
import { projectRoomAttachments } from '../attachment-projection.js';

/**
 * Lets one `link` fail on demand — the interruption that decides whether the
 * copy fallback works. Everything else passes straight through to the real
 * filesystem, so these are still tests against real files. The technique is
 * `local-avatar-store.test.ts`'s, applied to a different call.
 */
const fsControl = vi.hoisted(() => ({ linkFailure: null as string | null }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    default: actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fsControl.linkFailure) {
        const code = fsControl.linkFailure;
        fsControl.linkFailure = null;
        throw Object.assign(new Error(`simulated link failure (${code})`), { code });
      }
      return actual.link(...args);
    },
  };
});

const ROOM_ID = 'room1';
const BYTES = Buffer.from('the crash log, verbatim\n');

describe('projecting room attachments', () => {
  let dorkHome: string;
  let agentPath: string;
  let store: LocalRoomAttachmentStore;

  beforeEach(async () => {
    fsControl.linkFailure = null;
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-projection-home-'));
    agentPath = await mkdtemp(path.join(tmpdir(), 'dorkos-projection-agent-'));
    store = new LocalRoomAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(agentPath, { recursive: true, force: true });
  });

  /** Put one file in the store and describe it the way the context builder would. */
  async function staged(
    overrides: Partial<ProjectableAttachment> = {},
    bytes = BYTES
  ): Promise<ProjectableAttachment> {
    const file: ProjectableAttachment = {
      entryId: 'entry1',
      attachmentId: 'att1',
      extension: 'log',
      name: 'crash.log',
      relativePath: '',
      ...overrides,
    };
    await store.put(ROOM_ID, file.attachmentId, file.extension, bytes);
    return {
      ...file,
      relativePath: path.posix.join(
        PROJECTED_ATTACHMENTS_ROOT,
        file.entryId,
        `${file.attachmentId}-${file.name}`
      ),
    };
  }

  /** Where a planned file must end up. */
  function destinationOf(file: ProjectableAttachment): string {
    return path.join(agentPath, file.relativePath);
  }

  /** Run the projector over a plan. */
  async function project(
    attachments: readonly ProjectableAttachment[],
    opts: { store?: RoomAttachmentStore; now?: () => number } = {}
  ): Promise<void> {
    await projectRoomAttachments({
      store: () => opts.store ?? store,
      roomId: ROOM_ID,
      cwd: agentPath,
      attachments,
      now: opts.now,
    });
  }

  it('puts the file exactly where the context said it would be', async () => {
    const file = await staged();

    await project([file]);

    expect(await readFile(destinationOf(file))).toEqual(BYTES);
  });

  it('links rather than copies, so a large file costs no bytes', async () => {
    const file = await staged();

    await project([file]);

    // THE discriminating assertion. A copy leaves nlink 1; only a hardlink makes
    // the same inode reachable from two paths.
    expect((await stat(destinationOf(file))).nlink).toBe(2);
  });

  it.each(['EXDEV', 'EPERM'])('falls back to a copy when link fails with %s', async (code) => {
    const file = await staged();
    fsControl.linkFailure = code;

    await project([file]);

    expect(await readFile(destinationOf(file))).toEqual(BYTES);
    // A copy this time — a separate inode, which is exactly the fallback.
    expect((await stat(destinationOf(file))).nlink).toBe(1);
  });

  it('rethrows a link failure that is not about devices or permission', async () => {
    const file = await staged();
    fsControl.linkFailure = 'ENOSPC';

    // Swallowed by the projector's own contract rather than thrown at the turn,
    // so what is asserted is that nothing landed — not that it threw.
    await expect(project([file])).resolves.toBeUndefined();
    await expect(stat(destinationOf(file))).rejects.toThrow();
  });

  it('is a no-op the second time, leaving the same inode alone', async () => {
    const file = await staged();
    await project([file]);
    const first = await stat(destinationOf(file));

    await project([file]);
    const second = await stat(destinationOf(file));

    expect(second.ino).toBe(first.ino);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it('projects several files onto one entry', async () => {
    const first = await staged({ attachmentId: 'att1', name: 'a.log' });
    const second = await staged({ attachmentId: 'att2', name: 'b.txt', extension: 'txt' });

    await project([first, second]);

    expect(await readdir(path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT, 'entry1'))).toEqual(
      expect.arrayContaining(['att1-a.log', 'att2-b.txt'])
    );
  });

  it('never throws when a planned file is missing from the store', async () => {
    const ghost: ProjectableAttachment = {
      entryId: 'entry1',
      attachmentId: 'nobody',
      extension: 'log',
      name: 'ghost.log',
      relativePath: `${PROJECTED_ATTACHMENTS_ROOT}/entry1/nobody-ghost.log`,
    };

    // A turn must not fail because one file could not be brought over.
    await expect(project([ghost])).resolves.toBeUndefined();
  });

  it('refuses to write through a symlink that escapes the agent directory', async () => {
    // The steer an AGENT can plant: replace its own projection root with a link
    // to somewhere else, and every layer above still sees a contained relative
    // path. `realpath` is what sees through it.
    const outside = await mkdtemp(path.join(tmpdir(), 'dorkos-projection-outside-'));
    try {
      await mkdir(path.join(agentPath, '.dork', '.temp'), { recursive: true });
      await symlink(outside, path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT));
      const file = await staged();

      // Swallowed like any other projection failure — a turn must not die — so
      // the assertion is that nothing was written where it was aimed.
      await expect(project([file])).resolves.toBeUndefined();

      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('when the bytes are not on this machine', () => {
    /**
     * A store that keeps nothing locally — `localPath` answering `null` is the
     * honest signal that the projector has to fetch. This completes the third
     * case of the seam started in `room-attachment-store.test.ts`.
     */
    const remote: RoomAttachmentStore = {
      put: async () => ({ url: 'https://cdn.example/x.bin' }),
      get: async () => ({
        stream: Readable.from([BYTES]),
        contentType: 'application/octet-stream',
        etag: '"abc"',
        size: BYTES.byteLength,
      }),
      localPath: async () => null,
      delete: async () => {},
    };

    it('fetches the bytes instead of linking them', async () => {
      const file = await staged();
      // A fresh agent tree, so nothing from the local store is lying around.
      await rm(path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT), {
        recursive: true,
        force: true,
      });

      await project([file], { store: remote });

      expect(await readFile(destinationOf(file))).toEqual(BYTES);
      // Written, not linked: there is no local inode to share.
      expect((await stat(destinationOf(file))).nlink).toBe(1);
    });
  });

  describe('the sweep', () => {
    const HOUR = 60 * 60 * 1000;
    const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

    /** An entry directory left behind by an earlier turn, aged to `hoursOld`. */
    async function aged(entryId: string, hoursOld: number): Promise<string> {
      const directory = path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT, entryId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'old-file.log'), 'stale');
      const when = new Date(NOW - hoursOld * HOUR);
      await utimes(directory, when, when);
      return directory;
    }

    it('drops an entry directory older than a day and keeps a younger one', async () => {
      const stale = await aged('entry-stale', 25);
      const fresh = await aged('entry-fresh', 23);
      const file = await staged();

      await project([file], { now: () => NOW });

      await expect(stat(stale)).rejects.toThrow();
      expect((await stat(fresh)).isDirectory()).toBe(true);
    });

    it('does not run at all when there is nothing to project', async () => {
      const stale = await aged('entry-stale', 25);

      // Deliberate: a turn carrying no files does no filesystem work, so an
      // agent that has stopped receiving attachments keeps its last window.
      await project([], { now: () => NOW });

      expect((await stat(stale)).isDirectory()).toBe(true);
    });
  });
});
