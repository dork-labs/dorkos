/**
 * `ROOM.md` reaching a room turn (spec `project-rooms` §3.3).
 *
 * The runner is real and the dispatcher is stubbed to a recorder, which is what
 * lets this file assert the claims that cannot be read anywhere else:
 *
 * - **A room with no files dispatches exactly what it did before** — the field
 *   is ABSENT, not empty. What the layers below the runner do with the same
 *   promise is pinned in `session/__tests__/message-dispatcher.test.ts`.
 * - **The block is pinned to its turn.** It is composed from a real git repo, so
 *   a merge landing while the turn is in flight is a real merge, and the
 *   assertion is that the dispatch's argument did not move under it.
 * - **The default path is really connected.** The last block leaves the
 *   injection point alone and drives `readRoomConventions` →
 *   `tryGetRoomRepoService` → `RoomRepoService.conventionsFor` over a really
 *   enabled repo.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Passing `systemPromptAppend: ''` for a non-repo room reddens the zero-change
 *   case.
 * - Re-composing at dispatch time instead of at turn start reddens the pin (on
 *   the compose COUNT — the strings alone would still agree).
 * - Delivering the block on `additionalContext` reddens the seam case.
 * - Returning `null` from the default reader reddens the wiring case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { RoomTurnRequest } from '../room-trigger.js';

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    persistSessionRuntime: () => Promise.resolve(true),
    getSessionSettings: () => Promise.resolve({}),
    get: () => ({
      getCapabilities: () => ({
        logBackedHistory: false,
        nativeContext: [],
        settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
      }),
      acquireLock: () => true,
      releaseLock: () => undefined,
      sendMessage: () => undefined,
      interruptQuery: () => Promise.resolve(false),
      getInternalSessionId: (sessionId: string) => sessionId,
    }),
    has: () => true,
    getDefaultType: () => 'claude-code',
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: () => Promise.resolve(null) }));

vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'runtimes' ? USER_CONFIG_DEFAULTS.runtimes : USER_CONFIG_DEFAULTS.rooms,
  },
}));

/** Everything the runner handed the dispatcher, as this file inspects it. */
interface TriggerCall {
  sessionId: string;
  content: string;
  systemPromptAppend?: string;
  roomContext?: unknown;
  projector: { ingest: (event: Record<string, unknown>) => { seq: number } };
  onTurnStart?: (seq: number) => void;
}

/** Every dispatch, in order. */
const triggered: TriggerCall[] = [];

/**
 * Runs between the runner handing the dispatcher its arguments and the turn
 * opening — the window a merge would land in.
 */
let duringDispatch: () => Promise<void> = () => Promise.resolve();

vi.mock('../../session/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/index.js')>()),
  dispatchMessage: async (opts: TriggerCall) => {
    triggered.push(opts);
    await duringDispatch();
    const start = opts.projector.ingest({ type: 'turn_start' });
    opts.onTurnStart?.(start.seq);
    opts.projector.ingest({ type: 'text_delta', text: 'ok' });
    opts.projector.ingest({ type: 'turn_end' });
    return { accepted: true, canonicalId: opts.sessionId };
  },
}));

const { createSessionRoomTurnRunner } = await import('../room-turn-runner.js');
const { RoomConventions } = await import('../repo/room-conventions.js');
const { RoomRepoService } = await import('../repo/room-repo-service.js');
const { RoomRepoStore } = await import('../repo/room-repo-store.js');
const { commitAll, initRepo } = await import('../repo/room-repo-git.js');
const { ROOM_MD_FILENAME } = await import('../repo/room-md.js');
const { setRoomRepoService, tryGetRoomRepoService } = await import('../index.js');

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = { name: 'Dorian', email: 'operator@dorkos.local' };

/** A trigger request for the room under test. */
function request(): RoomTurnRequest {
  const room = {
    id: ROOM_ID,
    kind: 'channel',
    slug: 'release-train',
    title: 'Release train',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: null,
    createdAt: '2026-08-27T10:00:00.000Z',
    lastActivityAt: '2026-08-27T10:00:00.000Z',
    members: [],
    viewerAuthorId: 'human',
    reactionFrequents: ['👍'],
  } satisfies RoomWithRoster;
  const entry: RoomEntry = {
    roomId: room.id,
    seq: 1,
    id: 'entry-1',
    authorId: 'human',
    kind: 'post',
    body: { text: 'is the build green?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: room.createdAt,
  };
  return {
    room,
    authorId: 'author-ana',
    agentPath: '/repo/ana',
    sessionId: null,
    entry,
    prompt: entry.body.text,
    roomContext: {
      room: { id: room.id, kind: 'channel', name: '#release-train', bridged: false },
      thread: null,
      members: [],
      working: [],
      pending: [],
      pendingTruncated: false,
      ownRecent: [],
      acknowledgments: [],
      triggerEntryId: entry.id,
      triggerAttachments: [],
      addressing: {
        responseMode: 'always',
        engagedUntil: null,
        engagedPostsLeft: null,
        addressedNow: false,
      },
      budget: {
        automaticRepliesLeftInThisRoomThisHour: 9,
        automaticRepliesLeftInTotalThisHour: 99,
        repliesLeftInThisChain: 3,
      },
    },
    attachmentProjection: [],
    onWaiting: () => undefined,
    onActivity: () => undefined,
  };
}

describe('ROOM.md delivery', () => {
  let scratch: string;
  let home: string;
  let repo: string;
  let hasRepo: boolean;
  let conventions: InstanceType<typeof RoomConventions>;

  /** Write `ROOM.md` and commit it. */
  async function commitRoomMd(body: string): Promise<void> {
    await writeFile(path.join(repo, ROOM_MD_FILENAME), body, 'utf-8');
    await commitAll(repo, 'update the conventions', OPERATOR, home);
  }

  beforeEach(async () => {
    triggered.length = 0;
    composeCalls = 0;
    duringDispatch = () => Promise.resolve();
    scratch = await mkdtemp(path.join(await fsp.realpath(tmpdir()), 'dorkos-room-md-delivery-'));
    home = path.join(scratch, 'rooms', ROOM_ID);
    repo = path.join(home, 'repo');
    await mkdir(repo, { recursive: true });
    await initRepo(repo, home);
    hasRepo = true;
    conventions = new RoomConventions({
      hasRepo: () => hasRepo,
      repoPath: () => repo,
      homeDir: () => home,
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** How many times the runner asked the composer, across every turn. */
  let composeCalls = 0;

  /** A runner whose conventions come from the real composer over the real repo. */
  function runner() {
    return createSessionRoomTurnRunner({
      roomConventions: (room) => {
        composeCalls += 1;
        return conventions.compose(room);
      },
    });
  }

  it('a room with no files dispatches no append at all', async () => {
    hasRepo = false;
    await commitRoomMd('# Never sent\n');

    await runner().run(request());

    // Absent, not empty — the seam's own promise, so no consumer downstream has
    // to be careful. `''` happens to be inert today (every adapter guards with a
    // truthiness check), which is exactly why the guarantee is stated here
    // rather than inferred from four coincidences. The layers between this and
    // the runtime are pinned in `session/__tests__/message-dispatcher.test.ts`.
    expect(triggered).toHaveLength(1);
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('sends the conventions on systemPromptAppend, never in the message', async () => {
    await commitRoomMd('# Release train\n\nShip on Thursdays.\n');

    await runner().run(request());

    const dispatch = triggered[0]!;
    expect(dispatch.systemPromptAppend).toContain('Ship on Thursdays.');
    // `content` is what a person typed, byte for byte — the room's conventions
    // are standing framing, not part of anybody's message (ADR-0273).
    expect(dispatch.content).toBe('is the build green?');
    expect(JSON.stringify(dispatch.roomContext)).not.toContain('Ship on Thursdays');
  });

  it('holds the block for the whole turn — a merge mid-turn changes nothing', async () => {
    await commitRoomMd('# Release train\n\nShip on Thursdays.\n');
    // A real commit landing in the window between the runner handing over its
    // arguments and the turn opening. The next turn must see it; this one
    // must not (the session-snapshot discipline, ADR 260711-142049).
    duringDispatch = async () => {
      await commitRoomMd('# Release train\n\nShip on Mondays now.\n');
    };

    await runner().run(request());
    duringDispatch = () => Promise.resolve();
    await runner().run(request());

    expect(triggered).toHaveLength(2);
    expect(triggered[0]!.systemPromptAppend).toContain('Ship on Thursdays.');
    expect(triggered[0]!.systemPromptAppend).not.toContain('Ship on Mondays now.');
    // And the merge is not lost — it lands at the next turn boundary.
    expect(triggered[1]!.systemPromptAppend).toContain('Ship on Mondays now.');
    // ONCE per turn, at its start. This is the half of the pin the strings
    // cannot show: a runner that re-asked mid-turn — per event, or again on the
    // late-answer path — would still produce these two strings while having no
    // pin at all, and would move the block under an agent that had already been
    // told something else.
    expect(composeCalls).toBe(2);
  });

  it('answers the message even when the conventions read itself throws', async () => {
    // A throw out of `run` means NOTHING RAN to the dispatcher, which rewinds
    // the room's read cursor and replays the whole window — so one unreadable
    // cache row would replay somebody's conversation rather than dropping an
    // optional block (room-participation spec §8.3).
    const result = await createSessionRoomTurnRunner({
      roomConventions: () => Promise.reject(new Error('SQLITE_BUSY')),
    }).run(request());

    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('goes quiet rather than failing a turn when the room’s files are unreadable', async () => {
    await commitRoomMd('# Release train\n');
    await rm(path.join(repo, '.git'), { recursive: true, force: true });

    const result = await runner().run(request());

    // The message is still answered. A room whose files cannot be read is a
    // room without files for this turn — never a turn nobody gets an answer to.
    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });
});

/**
 * The DEFAULT path — the one production takes.
 *
 * Everything above injects a `roomConventions` reader, which proves the runner's
 * behaviour and nothing about the wiring underneath it. This block leaves that
 * option OFF, so the runner resolves through `readRoomConventions` →
 * `tryGetRoomRepoService()` → `RoomRepoService.conventionsFor` — three seams
 * that had no coverage at all, and any one of which could have been left
 * unconnected with every other test in this file still green.
 *
 * **The two cases are order-dependent, so the first one says so out loud.**
 * `setRoomRepoService` writes module state with no reset, so "no service is
 * registered" is only true before the other case runs. The precondition is
 * asserted rather than assumed: reordered, this fails loudly instead of passing
 * for the wrong reason.
 */
describe('the production wiring', () => {
  let scratch: string;
  let dorkHome: string;

  beforeEach(async () => {
    triggered.length = 0;
    scratch = await mkdtemp(path.join(await fsp.realpath(tmpdir()), 'dorkos-room-md-wiring-'));
    dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('answers without conventions when no repo service is registered', async () => {
    expect(
      tryGetRoomRepoService(),
      'this case must run before anything registers a service; see the block doc'
    ).toBeNull();

    const result = await createSessionRoomTurnRunner().run(request());

    // The embedded read-only subsystem is the ordinary case: it bootstraps no
    // repo service at all, and every room there is simply a room without files.
    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('reaches ROOM.md through the registered service, with nothing injected', async () => {
    const db = createTestDb();
    const store = new RoomRepoStore(db, dorkHome);
    const room = request().room;
    // `room_repos.room_id` is a foreign key, so the room has to exist before it
    // can be given files — the same order the enable route meets in production.
    db.insert(rooms)
      .values({
        id: room.id,
        kind: room.kind,
        title: room.title,
        topic: room.topic,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
      })
      .run();
    const service = new RoomRepoService({
      store,
      enabled: () => true,
      getRoom: () => room,
      isOwnerAuthor: (authorId) => authorId === 'author-operator',
      operatorGitName: () => 'Dorian',
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    // A real enable: the sidecar, `git init -b main`, and the seeded `ROOM.md`
    // committed as the operator. Nothing here writes the file by hand, so what
    // the turn carries is what the enable route really produces.
    const enabled = await service.enable(ROOM_ID, 'author-operator');
    expect(enabled.created).toBe(true);
    setRoomRepoService(service);

    // No `roomConventions` option: this is the default reader, end to end.
    const result = await createSessionRoomTurnRunner().run(request());

    expect(result.text).toBe('ok');
    const append = triggered[0]!.systemPromptAppend;
    expect(append).toContain('<dorkos_room_conventions room="Release train"');
    // The seeded file's own words, so the assertion cannot pass on framing alone.
    expect(append).toContain('This room has files of its own');
  });
});
