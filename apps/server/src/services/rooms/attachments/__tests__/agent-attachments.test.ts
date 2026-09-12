/**
 * What an agent may show a room, and what it may not.
 *
 * Over a REAL filesystem and a REAL registry, because the one thing this
 * feature could get wrong is a widening — and a widening is a filesystem
 * question. The case that matters most is the one `validateBoundary` alone
 * would have let through: a SECOND agent's working copy, in the same project
 * room, inside the global boundary, named by the first agent. It is refused
 * here with nothing written.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const uploads = { maxFileSize: 1_024 * 1_024, maxFiles: 3, allowedTypes: ['*/*'] };
vi.mock('../../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'uploads' ? uploads : undefined),
    set: () => {},
  },
}));

import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { roomsDomain } from '../../room-capabilities.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';
import { setRoomAttachmentStores } from '../attachment-stores.js';
import { projectRoomAttachments } from '../attachment-projection.js';
import { projectedAttachmentPath } from '../attachment-paths.js';
import type { RoomAttachmentStore } from '../room-attachment-store.js';

const ANA_PATH = '/agents/ana';
const KAI_PATH = '/agents/kai';
const agents = agentLookupFor({
  [ANA_PATH]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [KAI_PATH]: { name: 'kai', displayName: 'Kai', responseMode: 'always' },
});

/** A one-pixel PNG, so a `preview: 'image'` assertion means the bytes sniffed. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let root: string;
/** Ana's working copy, and Kai's — two worktrees under one boundary. */
let anaCwd: string;
let kaiCwd: string;
let bytesHome: string;
let store: RoomAttachmentStore;
let harness: RoomHarness;
let registry: CapabilityRegistry;
let roomId: string;

/** Invoke `rooms.post` as Ana, from Ana's own working directory. */
function post(input: Record<string, unknown>): Promise<unknown> {
  return registry.invoke('rooms.post', input, {
    identity: { agentPath: ANA_PATH, displayName: 'Ana' },
    cwd: anaCwd,
  } as Parameters<CapabilityRegistry['invoke']>[2]);
}

/** Every UNBOUND row this room holds — what a refusal must leave empty. */
function unboundRows() {
  return harness.attachments.listUnboundBefore(roomId, new Date(Date.now() + 60_000).toISOString());
}

/** The room's attachment directory, or `[]` when nothing ever wrote to it. */
async function storedFiles(): Promise<string[]> {
  return fs.readdir(path.join(bytesHome, 'rooms', roomId, 'attachments')).catch(() => []);
}

/** Nothing was written: no unbound rows, no bytes, no entry. */
async function nothingWasWritten(): Promise<void> {
  expect(unboundRows()).toHaveLength(0);
  expect(await storedFiles()).toEqual([]);
  expect(harness.service.readHistory(roomId, harness.human, { limit: 10 })).toHaveLength(0);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-agent-att-')));
  anaCwd = path.join(root, 'ana');
  kaiCwd = path.join(root, 'kai');
  bytesHome = path.join(root, 'dork');
  await fs.mkdir(anaCwd, { recursive: true });
  await fs.mkdir(kaiCwd, { recursive: true });
  // The boundary contains BOTH working copies, which is exactly the project-room
  // shape: `validateBoundary` alone would let Ana name Kai's file.
  await initBoundary(root);

  store = new LocalRoomAttachmentStore(bytesHome);
  harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
  setRoomAttachmentStores({ attachments: store, rows: harness.attachments });
  registry = composeRegistry([roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: harness.service },
  });
  roomId = harness.service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH, KAI_PATH] },
    harness.human
  ).id;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('an agent attaches a file it made', () => {
  it('stores the bytes, binds the rows to the entry, and renders it inline', async () => {
    await fs.writeFile(path.join(anaCwd, 'shot.png'), PNG);

    const result = (await post({
      roomId,
      text: 'the 500 is from the proxy',
      attachments: ['shot.png'],
    })) as { entryId: string; attached: number };

    expect(result.attached).toBe(1);
    const entry = harness.service
      .readHistory(roomId, harness.human, { limit: 10 })
      .find((e) => e.id === result.entryId);
    expect(entry?.attachments).toHaveLength(1);
    const attached = entry!.attachments![0];
    expect(attached.name).toBe('shot.png');
    // Sniffed from the BYTES, which is what decides whether it ever renders.
    expect(attached.preview).toBe('image');
    expect(attached.mimeType).toBe('image/png');
    // And the bytes really are in the room's store, not just a row.
    const stored = await store.get(roomId, attached.id, 'png', attached.mimeType);
    expect(stored).not.toBeNull();
  });

  it('refuses a file in ANOTHER agent’s working copy, and writes nothing', async () => {
    await fs.writeFile(path.join(kaiCwd, 'secret.png'), PNG);

    await expect(
      post({ roomId, text: 'look at this', attachments: ['../kai/secret.png'] })
    ).rejects.toMatchObject({ payload: { code: 'ATTACHMENT_PATH_REFUSED' } });

    // The whole point: inside the global boundary, outside Ana's own directory.
    await nothingWasWritten();
  });

  it('refuses an absolute path that leaves the agent’s own directory', async () => {
    await fs.writeFile(path.join(kaiCwd, 'secret.png'), PNG);

    await expect(
      post({ roomId, text: 'look', attachments: [path.join(kaiCwd, 'secret.png')] })
    ).rejects.toMatchObject({ payload: { code: 'ATTACHMENT_PATH_REFUSED' } });
    await nothingWasWritten();
  });

  it('refuses a symlink pointing out of the agent’s own directory', async () => {
    await fs.writeFile(path.join(kaiCwd, 'secret.png'), PNG);
    await fs.symlink(path.join(kaiCwd, 'secret.png'), path.join(anaCwd, 'link.png'));

    await expect(post({ roomId, text: 'look', attachments: ['link.png'] })).rejects.toMatchObject({
      payload: { code: 'ATTACHMENT_PATH_REFUSED' },
    });
    await nothingWasWritten();
  });

  it('refuses a folder and a missing file by name', async () => {
    await fs.mkdir(path.join(anaCwd, 'logs'));

    await expect(post({ roomId, text: 'a', attachments: ['logs'] })).rejects.toMatchObject({
      payload: { code: 'ATTACHMENT_UNREADABLE', error: expect.stringContaining('folder') },
    });
    await expect(post({ roomId, text: 'a', attachments: ['gone.png'] })).rejects.toMatchObject({
      payload: { code: 'ATTACHMENT_UNREADABLE', error: expect.stringContaining('gone.png') },
    });
    await nothingWasWritten();
  });

  it('refuses a file over the size limit, naming the file and the limit', async () => {
    await fs.writeFile(path.join(anaCwd, 'big.bin'), Buffer.alloc(uploads.maxFileSize + 1, 7));

    await expect(post({ roomId, text: 'a', attachments: ['big.bin'] })).rejects.toMatchObject({
      payload: { code: 'ATTACHMENT_TOO_LARGE', error: expect.stringContaining('big.bin') },
    });
    await nothingWasWritten();
  });

  it('refuses one file too many, and stores none of them', async () => {
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) {
      await fs.writeFile(path.join(anaCwd, name), PNG);
    }

    await expect(
      post({ roomId, text: 'a', attachments: ['a.png', 'b.png', 'c.png', 'd.png'] })
    ).rejects.toMatchObject({ payload: { code: 'TOO_MANY_ATTACHMENTS' } });
    await nothingWasWritten();
  });

  it('gives back every byte it wrote when a later file in the same post fails', async () => {
    await fs.writeFile(path.join(anaCwd, 'good.png'), PNG);

    await expect(
      post({ roomId, text: 'a', attachments: ['good.png', 'missing.png'] })
    ).rejects.toMatchObject({ payload: { code: 'ATTACHMENT_UNREADABLE' } });

    // The first file was already written when the second failed. All or nothing.
    await nothingWasWritten();
  });

  it('does not render a `.png` that is not one as an image', async () => {
    await fs.writeFile(path.join(anaCwd, 'liar.png'), '<script>alert(1)</script>');

    const result = (await post({ roomId, text: 'a', attachments: ['liar.png'] })) as {
      entryId: string;
    };

    const entry = harness.service
      .readHistory(roomId, harness.human, { limit: 10 })
      .find((e) => e.id === result.entryId);
    expect(entry?.attachments?.[0].preview).toBeNull();
    expect(entry?.attachments?.[0].mimeType).toBe('application/octet-stream');
  });

  it('reaches the other agent as a hardlink in its own working copy', async () => {
    await fs.writeFile(path.join(anaCwd, 'shot.png'), PNG);
    const result = (await post({ roomId, text: '@kai look', attachments: ['shot.png'] })) as {
      entryId: string;
    };
    const entry = harness.service
      .readHistory(roomId, harness.human, { limit: 10 })
      .find((e) => e.id === result.entryId)!;

    const file = entry.attachments![0];
    const relativePath = projectedAttachmentPath(entry.id, file.id, file.name);
    await projectRoomAttachments({
      store: () => store,
      roomId,
      cwd: kaiCwd,
      attachments: [
        {
          entryId: entry.id,
          attachmentId: file.id,
          extension: 'png',
          name: file.name,
          relativePath,
        },
      ],
    });

    const projected = path.join(kaiCwd, relativePath);
    expect((await fs.readFile(projected)).equals(PNG)).toBe(true);
    // A hardlink, not a copy: the same inode as the room's own stored file.
    const [projectedStat, sourceStat] = await Promise.all([
      fs.stat(projected),
      fs.stat(path.join(bytesHome, 'rooms', roomId, 'attachments', `${file.id}.png`)),
    ]);
    expect(projectedStat.ino).toBe(sourceStat.ino);
  });

  it('posts with no attachments exactly as it always did', async () => {
    const result = (await post({ roomId, text: 'just words' })) as {
      posted: boolean;
      attached?: number;
    };

    expect(result.posted).toBe(true);
    expect(result.attached).toBeUndefined();
    // The message landed; no file did, and the attachment stores were never
    // asked for — a post with no files must work on a surface that has no
    // working directory at all.
    expect(harness.service.readHistory(roomId, harness.human, { limit: 10 })).toHaveLength(1);
    expect(unboundRows()).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);
  });
});
