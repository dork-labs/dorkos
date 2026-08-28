/**
 * The phase's whole claim, asserted end to end: **every path an agent is told
 * about is one it can open.**
 *
 * Three modules have to agree for that to be true, and they are written in
 * three different files — `buildRoomContext` decides which entries reach the
 * model and names their files, `room-context-block` renders those names into
 * the prompt, and `attachment-projection` puts bytes on disk. Each of them has
 * its own unit tests. None of those can catch the two drifting apart, which is
 * the failure ADR 260807-233816 exists to prevent and the only failure that is
 * completely silent: the model is handed a path, opens nothing, and no log line
 * anywhere says why.
 *
 * So this test reads the paths back out of the RENDERED BLOCK — the actual
 * string the model receives, not the structured data behind it — and opens
 * every one of them. And it asserts the converse too: a file on an entry that
 * fell outside the context window is projected for nobody, because projecting
 * what the model cannot see would be bytes written for no reader.
 *
 * Real temp filesystem, real store, real projector. The only stand-in is the
 * turn runner, because the alternative is a model call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { ROOM_ATTACHMENT_NAME_MAX, type RoomWithRoster } from '@dorkos/shared/room-schemas';
import { formatRoomContext } from '../../runtimes/shared/room-context-block.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { AttachmentRowStore } from '../attachments/attachment-row-store.js';
import { LocalRoomAttachmentStore } from '../attachments/local-room-attachment-store.js';
import { projectRoomAttachments } from '../attachments/attachment-projection.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../attachments/attachment-paths.js';
import type { ProjectableAttachment } from '../room-context.js';
import type { RoomService } from '../room-service.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

/** The window `buildRoomContext` renders; more entries than this and the oldest fall out. */
const PENDING_MAX_ENTRIES = 30;

describe('every path the agent is told about', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let attachments: AttachmentRowStore;
  let runner: ReturnType<typeof scriptedRunner>;
  let room: RoomWithRoster;
  let human: string;
  let dorkHome: string;
  let agentPath: string;
  let store: LocalRoomAttachmentStore;
  let uploaded = 0;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-open-home-'));
    agentPath = await mkdtemp(path.join(tmpdir(), 'dorkos-open-agent-'));
    store = new LocalRoomAttachmentStore(dorkHome);
    uploaded = 0;

    runner = scriptedRunner(() => null);
    // **The agent's directory IS the temp tree the projector writes into**, and
    // since DOR-1266 that identity is what the test turns on: the rendered path
    // is absolute, anchored at whatever `agentPath` the dispatcher passed, so a
    // fixture that named the agent `/agents/ana` while projecting somewhere else
    // would render a path that could never open — and would prove nothing about
    // production, where the two are the same directory by construction.
    const agents = agentLookupFor({
      [agentPath]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
    });
    ({ service, authors, attachments, human } = createRoomHarness({ agents, runner }));
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [agentPath] },
      human
    );
    // `mention-only` so the messages carrying files do NOT wake Ana: her read
    // cursor stays where it started, so those messages are still unread — and
    // therefore still in the context window — when the final `@ana` triggers
    // her. Under `always` each post advances the cursor past itself, and the
    // window this test is about would be empty (main's ambient window, RP3).
    const ana = authors.resolveAgent(agentPath, 'Ana').id;
    service.updateMembership(room.id, human, ana, 'mention-only');
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(agentPath, { recursive: true, force: true });
  });

  /** Upload one file, bytes and row, exactly as the upload route would. */
  async function upload(name: string): Promise<string> {
    uploaded += 1;
    const id = `att${uploaded}`;
    const extension = name.split('.').pop() ?? '';
    const { url } = await store.put(room.id, id, extension, Buffer.from(`bytes of ${name}`));
    attachments.create(
      {
        roomId: room.id,
        id,
        authorId: human,
        name,
        extension,
        mimeType: 'text/plain',
        size: 11,
        preview: null,
        url,
      },
      `2026-08-08T10:0${uploaded}:00.000Z`
    );
    return id;
  }

  /** The turn the agent was last given: what it was told, and what was planned. */
  function lastTurn(): { block: string; projection: readonly ProjectableAttachment[] } {
    const turn = runner.turns[runner.turns.length - 1];
    if (!turn) throw new Error('the agent was never triggered');
    return {
      block: formatRoomContext(turn.roomContext, { nonce: 'aaaa1111' }),
      projection: turn.attachmentProjection,
    };
  }

  /** Every path named in an `[attached: …]` suffix of the rendered block. */
  function toldPaths(block: string): string[] {
    const found: string[] = [];
    for (const line of block.split('\n')) {
      const match = /\[attached: ([^\]]+)\]/.exec(line);
      if (match) found.push(...match[1].split(', '));
    }
    return found;
  }

  it('can be opened, and nothing outside the window was written', async () => {
    // A file on an entry that will age out of the window.
    const stale = await upload('ancient.log');
    service.post(room.id, { authorId: human, text: 'the old one', attachmentIds: [stale] });
    await service.triggersIdle();

    // Push it out.
    for (let n = 0; n <= PENDING_MAX_ENTRIES; n += 1) {
      service.post(room.id, { authorId: human, text: `filler ${n}` });
    }
    await service.triggersIdle();

    // Two files on an entry that stays in it.
    const first = await upload('crash.log');
    const second = await upload('trace.txt');
    service.post(room.id, {
      authorId: human,
      text: 'both of these',
      attachmentIds: [first, second],
    });
    await service.triggersIdle();
    service.post(room.id, { authorId: human, text: '@ana any idea?' });
    await service.triggersIdle();

    const { block, projection } = lastTurn();

    // The production runner does exactly this, before the turn.
    await projectRoomAttachments({
      store: () => store,
      roomId: room.id,
      cwd: agentPath,
      attachments: projection,
    });

    // 1. The model really was told about these files.
    const told = toldPaths(block);
    expect(told).toHaveLength(2);
    expect(told).toEqual([
      expect.stringContaining('crash.log'),
      expect.stringContaining('trace.txt'),
    ]);

    // 2. THE CLAIM: every path in the prompt opens, read back out of the
    //    rendered string rather than out of the structure that produced it —
    //    and opened AS WRITTEN, with nothing joined onto it here, because
    //    "as written" is exactly what the model gets to do with it (DOR-1266).
    for (const told of toldPaths(block)) {
      expect(path.isAbsolute(told), `the agent was told a relative path: ${told}`).toBe(true);
      await expect(
        access(told),
        `the agent was told about ${told}, which is not there`
      ).resolves.toBeUndefined();
    }

    // 3. The converse: nothing was written for the entry that aged out. One
    //    entry directory, holding exactly the two files the model can see.
    const projectedEntries = await readdir(path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT));
    expect(projectedEntries).toHaveLength(1);
    const projectedFiles = await readdir(
      path.join(agentPath, PROJECTED_ATTACHMENTS_ROOT, projectedEntries[0])
    );
    expect(projectedFiles.sort()).toEqual([`${first}-crash.log`, `${second}-trace.txt`]);
    expect(projectedFiles.some((name) => name.includes('ancient'))).toBe(false);
  });

  it('can be opened even when the filename is the longest one allowed', async () => {
    // `ROOM_ATTACHMENT_NAME_MAX` is 255, and the projected basename prefixes the
    // name with a 26-character ULID and a dash — 282 bytes, past the 255-byte
    // NAME_MAX every mainstream filesystem enforces. Before this was capped the
    // link/copy threw ENAMETOOLONG, the projector logged and swallowed it, and
    // the model was handed a path to a file that was never written: exactly the
    // half-state ADR 260807-233816 says cannot happen.
    const longName = `${'x'.repeat(ROOM_ATTACHMENT_NAME_MAX - '.log'.length)}.log`;
    expect(longName).toHaveLength(ROOM_ATTACHMENT_NAME_MAX);

    const file = await upload(longName);
    service.post(room.id, { authorId: human, text: 'the big one', attachmentIds: [file] });
    await service.triggersIdle();
    service.post(room.id, { authorId: human, text: '@ana any idea?' });
    await service.triggersIdle();

    const { block, projection } = lastTurn();
    await projectRoomAttachments({
      store: () => store,
      roomId: room.id,
      cwd: agentPath,
      attachments: projection,
    });

    const told = toldPaths(block);
    expect(told).toHaveLength(1);
    // Every component of the path a filesystem has to hold is within its limit.
    for (const segment of told[0].split('/')) {
      expect(Buffer.byteLength(segment), `segment "${segment}" is too long`).toBeLessThanOrEqual(
        255
      );
    }
    // And the trimmed name still ends in the suffix it was uploaded with, so the
    // file still reads as what it is.
    expect(told[0].endsWith('.log')).toBe(true);
    // THE claim: the path the model was told still opens, as written.
    await expect(
      access(told[0]),
      `the agent was told about ${told[0]}, which is not there`
    ).resolves.toBeUndefined();
  });

  it('delivers the files on the message that TRIGGERED the turn', async () => {
    // The most ordinary case there is — "@ana look at this" with a file on it —
    // and the one the window cannot carry: the triggering entry is deliberately
    // excluded from `pending` because it reaches the model as the turn's
    // content. That exclusion took its FILES with it, so the words arrived and
    // the file silently did not.
    const file = await upload('crash.log');
    const posted = service.post(room.id, {
      authorId: human,
      text: '@ana look at this',
      attachmentIds: [file],
    });
    await service.triggersIdle();

    const { block, projection } = lastTurn();
    await projectRoomAttachments({
      store: () => store,
      roomId: room.id,
      cwd: agentPath,
      attachments: projection,
    });

    // The entry is NOT in the window — that is the whole point of the case.
    const turn = runner.turns[runner.turns.length - 1];
    expect(turn.roomContext.pending.some((entry) => entry.text.includes('look at this'))).toBe(
      false
    );

    // But its file is named, in the labels region beside the rest of what DorkOS
    // says about the message being answered.
    const told = path.join(
      agentPath,
      `.dork/.temp/room-attachments/${posted.id}/${file}-crash.log`
    );
    expect(block).toContain(`A file is attached to the message you are answering: ${told}`);

    // And the claim: the path the model was told OPENS, as written.
    await expect(
      access(told),
      `the agent was told about ${told}, which is not there`
    ).resolves.toBeUndefined();
  });

  it('says nothing about the triggering message when it carried no files', async () => {
    service.post(room.id, { authorId: human, text: '@ana any idea?' });
    await service.triggersIdle();

    const { block, projection } = lastTurn();

    expect(block).not.toContain('attached to the message you are answering');
    expect(projection).toEqual([]);
  });

  it('tells the agent nothing when a message carried no files', async () => {
    service.post(room.id, { authorId: human, text: 'just words' });
    await service.triggersIdle();
    service.post(room.id, { authorId: human, text: '@ana any idea?' });
    await service.triggersIdle();

    const { block, projection } = lastTurn();

    expect(toldPaths(block)).toEqual([]);
    expect(projection).toEqual([]);
  });
});
