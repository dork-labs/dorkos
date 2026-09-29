/**
 * Starting work in a new chat (spec `flow-multiproject` §7.7): one start
 * launches one chat in the project's root with its title and the prompt as its
 * first message, and the chat says who started it on the session list and the
 * live stream. A folder outside every project, a project the extension may not
 * see, an ineligible account, the hourly limit and the running limit each
 * refuse and launch nothing. The limits survive a restart and count chats
 * started from started chats.
 *
 * The launch service is the edge: it is replaced so a start can be observed
 * without a runtime. Everything else is real, down to the table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ProjectInfo, ProjectRef } from '@dorkos/extension-api/server';
import { START_WORK_LIMITS } from '@dorkos/shared/extension-decision-schemas';
import { FakeAgentRuntime, createMockSession } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

/** Every launch the seam asked for, and the settle callback of each. */
const launches = vi.hoisted(
  () =>
    [] as Array<{
      sessionId: string;
      origin: { kind: string };
      request: { content: string; cwd?: string; runtime?: string };
      clientId: string;
      countsTowardLaunchCap?: boolean;
      onSettled?: (outcome: 'ok' | 'failed') => void;
    }>
);
/** What the next launch answers: accepted under the same id unless a test says otherwise. */
const nextLaunch = vi.hoisted(() => ({
  refused: null as null | { refused: string; message: string },
  canonical: null as null | ((id: string) => string),
}));

vi.mock('../../session/launch/launch-session.js', () => ({
  AGENT_LAUNCH_CAP_MESSAGE: 'Too many agent-started sessions are running (8).',
  isSessionLaunchRefusal: (result: object) => 'refused' in result,
  dispatchSessionMessage: vi.fn(async (opts: (typeof launches)[number]) => {
    launches.push(opts);
    if (nextLaunch.refused) return nextLaunch.refused;
    return {
      accepted: true,
      canonicalId: nextLaunch.canonical ? nextLaunch.canonical(opts.sessionId) : opts.sessionId,
      outcome: { kind: 'started', messageId: 'm-1' },
      queued: false,
      queuePosition: 1,
    };
  }),
}));

import { eventFanOut } from '../../core/event-fan-out.js';
import { SessionListBroadcaster } from '../../session/session-list-broadcaster.js';
import { applySessionOriginOverlays } from '../../session/origin/session-origin-overlays.js';
import { _forgetTitles } from '../../session/origin/started-by-origin-overlay.js';
import { SessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import {
  StartWorkInputError,
  StartWorkService,
  setStartWorkService,
  type StartWorkDeps,
} from '../start-work.js';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { createInboxFixture, shipDecision } from '../inbox/__tests__/inbox-fixture.js';
import { startSorting } from '../inbox/__tests__/fixtures/inbox-fixture.js';

const DORKOS: ProjectRef = { root: '/repos/dorkos', name: 'dorkos' };
const BLINTZ: ProjectRef = { root: '/repos/blintz', name: 'blintz' };
const MINE: ProjectRef = { root: '/repos/mine', name: 'mine' };

const info = (ref: ProjectRef): ProjectInfo => ({ ...ref, originRepo: null, lastSeenAt: '' });

/**
 * The registry: three repos under `/repos`, `/etc` outside the boundary,
 * anything else in no repo. `resolveWithin` and `report` are here only to prove
 * a start never calls them: both record a `reported` row.
 */
function fakeProjects(scope: Record<string, ProjectRef[]>) {
  const all = [DORKOS, BLINTZ, MINE];
  return {
    rootWithin: vi.fn(async (dir: string) => {
      if (dir.startsWith('/etc')) return 'outside' as const;
      return all.find((p) => dir === p.root || dir.startsWith(`${p.root}/`))?.root ?? null;
    }),
    listForExtension: vi.fn(async (id: string) => (scope[id] ?? []).map(info)),
    // The projects the person works in.
    list: vi.fn(async () => [info(MINE), info(DORKOS)]),
    resolveWithin: vi.fn(),
    report: vi.fn(),
  };
}

const INPUT = {
  project: '/repos/dorkos/apps/server',
  prompt: 'Sort the 12 new ideas in the tracker into the right stage.',
  title: 'Sorting 12 new ideas in dorkos',
  reason: '12 new ideas were waiting to be sorted',
};

let db: Db;
let store: SessionStartedByStore;
let clock: number;
let running: string[];
let renamed: Array<{ runtime: string; sessionId: string; title: string; cwd: string }>;
let service: StartWorkService;
let projects: ReturnType<typeof fakeProjects>;

function build(overrides: Partial<StartWorkDeps> = {}): StartWorkService {
  return new StartWorkService({
    store,
    projects,
    extensionName: (id) => ({ flow: 'Flow', 'hello-world': 'Hello World' })[id] ?? id,
    now: () => clock,
    runningSessionIds: () => running,
    defaultRuntime: () => 'test-mode',
    rename: async (runtime, sessionId, title, cwd) => {
      renamed.push({ runtime, sessionId, title, cwd });
    },
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>): Promise<StartWorkError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(StartWorkError);
  return err as StartWorkError;
}

beforeEach(() => {
  launches.length = 0;
  nextLaunch.refused = null;
  nextLaunch.canonical = null;
  db = createTestDb();
  store = new SessionStartedByStore(db);
  clock = Date.parse('2026-09-29T09:00:00.000Z');
  running = [];
  renamed = [];
  projects = fakeProjects({ flow: [DORKOS, BLINTZ], 'hello-world': [] });
  service = build();
  _forgetTitles();
});

afterEach(() => {
  setStartWorkService(undefined);
});

describe('a start', () => {
  it('launches one chat in the project root, with its title and the prompt as its first message', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');

    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expect(launch).toMatchObject({
      sessionId,
      origin: { kind: 'extension-start' },
      request: {
        content: INPUT.prompt,
        cwd: DORKOS.root,
        runtime: 'test-mode',
        // One honest line for the model; the prompt stays byte for byte.
        seedContext: `This chat was started by the Flow extension: ${INPUT.reason}`,
      },
      clientId: 'extension:flow',
      countsTowardLaunchCap: true,
    });
    expect(renamed).toEqual([
      { runtime: 'test-mode', sessionId, title: INPUT.title, cwd: DORKOS.root },
    ]);
    expect(store.get(sessionId)).toMatchObject({
      kind: 'extension',
      extensionId: 'flow',
      originExtensionId: 'flow',
      startedBySessionId: null,
      reason: INPUT.reason,
    });
  });

  it('says who started it on the session list', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    const rows: Session[] = [
      createMockSession({ id: sessionId, title: INPUT.title }),
      createMockSession({ id: 'someone-else', title: 'Mine' }),
    ];
    applySessionOriginOverlays(rows, {
      resolveStartedBy: (ids) => store.getMany(ids),
      extensionNameOf: () => 'Flow',
    });
    expect(rows[0]!.startedBy).toEqual({
      kind: 'extension',
      extensionId: 'flow',
      extensionName: 'Flow',
      reason: INPUT.reason,
    });
    expect(rows[1]!.startedBy).toBeUndefined();
  });

  it('says who started it on the live session stream', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    const runtime = new FakeAgentRuntime();
    const upsert: SessionListEvent = {
      type: 'session_upserted',
      session: createMockSession({ id: sessionId, title: INPUT.title }),
    };
    runtime.subscribeSessionList.mockReturnValue(
      (async function* () {
        yield upsert;
      })()
    );
    const broadcaster = new SessionListBroadcaster();
    broadcaster.setOriginResolvers({
      resolveStartedBy: (ids) => store.getMany(ids),
      extensionNameOf: () => 'Flow',
    });
    broadcaster.start([runtime]);
    try {
      await vi.waitFor(() =>
        expect(broadcast).toHaveBeenCalledWith(
          'session_upserted',
          expect.objectContaining({
            session: expect.objectContaining({
              id: sessionId,
              startedBy: expect.objectContaining({ kind: 'extension', extensionName: 'Flow' }),
            }),
          })
        )
      );
    } finally {
      await broadcaster.stop();
      broadcast.mockRestore();
    }
  });

  it('keeps who started it when the runtime settles on another id', async () => {
    nextLaunch.canonical = (id) => `sdk-${id}`;
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    expect(sessionId).toMatch(/^sdk-/);
    expect(store.get(sessionId)?.extensionId).toBe('flow');
    expect(store.get(sessionId.slice('sdk-'.length))).toBeNull();
    expect(renamed[0]!.sessionId).toBe(sessionId);
  });

  it('sets the title after the first turn when the runtime cannot set it yet', async () => {
    let calls = 0;
    service = build({
      rename: async (runtime, sessionId, title, cwd) => {
        calls += 1;
        if (calls === 1) throw new Error('no transcript yet');
        renamed.push({ runtime, sessionId, title, cwd });
      },
    });
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    expect(renamed).toEqual([]);
    launches[0]!.onSettled?.('ok');
    await vi.waitFor(() => expect(renamed).toHaveLength(1));
    expect(renamed[0]).toMatchObject({ sessionId, title: INPUT.title });
  });

  it('is reachable as ctx.sessions.start, scoped to the calling extension', async () => {
    setStartWorkService(service);
    const dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'start-work-ctx-'));
    const { ctx, releaseListeners } = createDataProviderContext({
      extensionId: 'flow',
      extensionDir: dorkHome,
      dorkHome,
      extensionName: 'Flow',
    });
    try {
      const { sessionId } = await startSorting(ctx, INPUT.project);
      expect(store.get(sessionId)).toMatchObject({
        extensionId: 'flow',
        reason: '12 new ideas were waiting to be sorted',
      });
      expect(launches[0]!.request.cwd).toBe(DORKOS.root);
    } finally {
      releaseListeners();
      fs.rmSync(dorkHome, { recursive: true, force: true });
    }
  });
});

describe('refusals launch nothing', () => {
  it('refuses a folder outside every project', async () => {
    const err = await refusal(service.start('flow', { ...INPUT, project: '/tmp/scratch' }, 'ctx'));
    expect(err.code).toBe('not_a_project');
    expect(err.message).toMatch(/isn't in a project Flow can start work in/);
    expect(launches).toHaveLength(0);
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('refuses a folder outside the boundary', async () => {
    const err = await refusal(service.start('flow', { ...INPUT, project: '/etc' }, 'ctx'));
    expect(err.code).toBe('not_a_project');
    expect(launches).toHaveLength(0);
  });

  it('refuses ctx.sessions.start in a project without a copy of the extension', async () => {
    const err = await refusal(service.start('flow', { ...INPUT, project: MINE.root }, 'ctx'));
    expect(err.code).toBe('not_a_project');
    expect(launches).toHaveLength(0);
    // Nothing recorded: no `reported` row, no report slot spent.
    expect(projects.resolveWithin).not.toHaveBeenCalled();
    expect(projects.report).not.toHaveBeenCalled();
  });

  it('lets a person start work from the page in a project they work in', async () => {
    // hello-world ships inside DorkOS, so no project holds a copy of it: its
    // button reaches only the projects the person works in.
    await expect(
      service.start('hello-world', { ...INPUT, project: MINE.root }, 'api')
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
    const err = await refusal(
      service.start('hello-world', { ...INPUT, project: BLINTZ.root }, 'api')
    );
    expect(err.code).toBe('not_a_project');
    expect(launches).toHaveLength(1);
  });

  it('refuses when no account may work in the project', async () => {
    const eligibility = vi.fn(() => ({
      ok: false as const,
      message:
        'No account is allowed to work in dorkos. Choose which accounts it may use in Settings → Runtimes.',
    }));
    service = build({ eligibility });
    const err = await refusal(service.start('flow', INPUT, 'ctx'));
    expect(err.code).toBe('account_not_allowed_here');
    expect(err.message).toMatch(/No account is allowed to work in dorkos/);
    expect(eligibility).toHaveBeenCalledWith({ project: DORKOS, runtime: 'test-mode' });
    expect(launches).toHaveLength(0);
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('refuses the eleventh start in an hour', async () => {
    for (let i = 0; i < START_WORK_LIMITS.perHour; i++) {
      await service.start('flow', INPUT, 'ctx');
      // Each one finishes, so only the hourly limit is in play.
      launches.at(-1)!.onSettled?.('ok');
      clock += 60_000;
    }
    const err = await refusal(service.start('flow', INPUT, 'ctx'));
    expect(err).toMatchObject({
      code: 'start_limit',
      message: 'Flow has started a lot of chats in the last hour. Try again later.',
    });
    expect(launches).toHaveLength(START_WORK_LIMITS.perHour);

    // Another extension has a limit of its own.
    await expect(
      service.start('hello-world', { ...INPUT, project: MINE.root }, 'api')
    ).resolves.toBeTruthy();
    // And the oldest start falls out of the hour.
    clock += 60 * 60_000 - 9 * 60_000;
    await expect(service.start('flow', INPUT, 'ctx')).resolves.toBeTruthy();
  });

  it('refuses a fourth chat while three are working, and allows it once one finishes', async () => {
    for (let i = 0; i < START_WORK_LIMITS.running; i++) await service.start('flow', INPUT, 'ctx');
    const err = await refusal(service.start('flow', INPUT, 'ctx'));
    expect(err).toMatchObject({
      code: 'start_limit',
      message: 'Flow already has 3 chats working. Try again when one finishes.',
    });
    expect(launches).toHaveLength(START_WORK_LIMITS.running);

    launches[0]!.onSettled?.('ok');
    await expect(service.start('flow', INPUT, 'ctx')).resolves.toBeTruthy();
  });

  it('counts a started chat that is working on a later turn, from the live statuses', async () => {
    const ids: string[] = [];
    for (let i = 0; i < START_WORK_LIMITS.running; i++) {
      ids.push((await service.start('flow', INPUT, 'ctx')).sessionId);
      launches.at(-1)!.onSettled?.('ok');
    }
    // All three finished their first turn; a person then sent each a message.
    running = [...ids, 'someone-elses-chat'];
    expect((await refusal(service.start('flow', INPUT, 'ctx'))).code).toBe('start_limit');
    running = ids.slice(1);
    await expect(service.start('flow', INPUT, 'ctx')).resolves.toBeTruthy();
  });

  it('refuses as account_not_allowed_here when the launch’s own account check refuses', async () => {
    nextLaunch.refused = {
      refused: 'ACCOUNT_NOT_ALLOWED',
      message: "dorkos isn't set to use Work. Pick another account.",
    };
    const err = await refusal(service.start('flow', INPUT, 'ctx'));
    expect(err).toMatchObject({
      code: 'account_not_allowed_here',
      message: "dorkos isn't set to use Work. Pick another account.",
    });
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('refuses a launch the machine-wide cap refused, and forgets it', async () => {
    nextLaunch.refused = { refused: 'LAUNCH_CAP_FULL', message: 'full' };
    const err = await refusal(service.start('flow', INPUT, 'ctx'));
    expect(err.code).toBe('start_limit');
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('refuses input that breaks a length rule, as a StartWorkInputError', async () => {
    await expect(service.start('flow', { ...INPUT, title: 'x'.repeat(81) }, 'ctx')).rejects.toThrow(
      StartWorkInputError
    );
    await expect(service.start('flow', { ...INPUT, reason: '' }, 'ctx')).rejects.toThrow(
      /Say why in 1 to 200 characters/
    );
    await expect(
      service.start('flow', { ...INPUT, prompt: 'x'.repeat(20_001) }, 'ctx')
    ).rejects.toThrow(/under 20,000 characters/);
    expect(launches).toHaveLength(0);
  });
});

describe('the limits', () => {
  it('survive a restart: the hourly count is read from the table', async () => {
    for (let i = 0; i < START_WORK_LIMITS.perHour; i++) {
      await service.start('flow', INPUT, 'ctx');
      launches.at(-1)!.onSettled?.('ok');
    }
    // A new process: nothing in memory, the same database.
    const restarted = build();
    expect((await refusal(restarted.start('flow', INPUT, 'ctx'))).code).toBe('start_limit');
  });

  it('count chats started from a started chat', async () => {
    const parent = await service.start('flow', INPUT, 'ctx');
    launches.at(-1)!.onSettled?.('ok');
    // The parent chat starts another (what `session_start` records).
    const child = service.reserve({
      sessionId: 'child-1',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: parent.sessionId,
      originExtensionId: store.get(parent.sessionId)!.originExtensionId,
      reason: 'split the work',
    });
    expect(child.ok).toBe(true);
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(2);
    // Running, it holds one of the three slots.
    for (let i = 0; i < START_WORK_LIMITS.running - 1; i++)
      await service.start('flow', INPUT, 'ctx');
    expect((await refusal(service.start('flow', INPUT, 'ctx'))).code).toBe('start_limit');
    // And a chat started from it is refused at the limit too.
    const grandchild = service.reserve({
      sessionId: 'grandchild-1',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'child-1',
      originExtensionId: 'flow',
      reason: null,
    });
    expect(grandchild).toMatchObject({ ok: false, error: { code: 'start_limit' } });
    expect(store.get('grandchild-1')).toBeNull();
  });

  it('never limit a chat whose chain reaches no extension', () => {
    for (let i = 0; i < 20; i++) {
      const claimed = service.reserve({
        sessionId: `plain-${i}`,
        kind: 'chat',
        extensionId: null,
        startedBySessionId: 'a-persons-chat',
        originExtensionId: null,
        reason: null,
      });
      expect(claimed.ok).toBe(true);
    }
  });
});

describe('keeping starts', () => {
  it('keeps a start however old, so an old chat still folds its prompt and its chats still count', async () => {
    const old = new Date(clock - 90 * 24 * 60 * 60 * 1000).toISOString();
    store.insert({
      sessionId: 'old-chat',
      kind: 'extension',
      extensionId: 'flow',
      startedBySessionId: null,
      originExtensionId: 'flow',
      reason: 'r',
      createdAt: old,
    });
    expect('prune' in store).toBe(false);
    expect(service.startedBy('flow', 'old-chat')).toBe(true);
  });
});

describe('startedBy', () => {
  it('answers whether an extension started a chat, or a chat started from one', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    service.reserve({
      sessionId: 'child-1',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: sessionId,
      originExtensionId: 'flow',
      reason: null,
    });
    expect(service.startedBy('flow', sessionId)).toBe(true);
    expect(service.startedBy('flow', 'child-1')).toBe(true);
    expect(service.startedBy('hello-world', sessionId)).toBe(false);
    expect(service.startedBy('flow', 'a-persons-chat')).toBe(false);
  });

  it('names the chat a chat was started from, when this server has listed it', () => {
    store.insert({
      sessionId: 'child-1',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'parent-1',
      originExtensionId: null,
      reason: 'split the work',
      createdAt: new Date(clock).toISOString(),
    });
    const rows = [
      createMockSession({ id: 'parent-1', title: 'Plan the launch' }),
      createMockSession({ id: 'child-1', title: 'Write the post' }),
    ];
    applySessionOriginOverlays(rows, { resolveStartedBy: (ids) => store.getMany(ids) });
    expect(rows[1]!.startedBy).toEqual({
      kind: 'chat',
      sessionId: 'parent-1',
      title: 'Plan the launch',
      reason: 'split the work',
    });

    _forgetTitles();
    const alone = [createMockSession({ id: 'child-1', title: 'Write the post' })];
    applySessionOriginOverlays(alone, { resolveStartedBy: (ids) => store.getMany(ids) });
    expect(alone[0]!.startedBy).toMatchObject({ kind: 'chat', title: null });
  });
});

describe('a watch on an inbox row (§7.3)', () => {
  it('draws "· Watch" for a chat the extension started, and drops any other', async () => {
    const started = await service.start('flow', INPUT, 'ctx');
    const other = await service.start('hello-world', { ...INPUT, project: MINE.root }, 'api');
    const fx = createInboxFixture({
      watchAllowed: (extensionId, sessionId) => service.startedBy(extensionId, sessionId),
    });
    try {
      fx.inbox.markRunning('flow', 'Flow');
      const word = {
        kind: 'word' as const,
        label: 'Sort them',
        input: { placeholder: 'x', maxLength: 10 },
      };
      fx.inbox.setHandler('flow', ({ key }) =>
        key === 'mine'
          ? { keepOpen: true, watch: { sessionId: started.sessionId, label: 'Sorting 12 ideas…' } }
          : { keepOpen: true, watch: { sessionId: other.sessionId, label: 'Not mine' } }
      );
      await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'mine', actions: word }));
      await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'theirs', actions: word }));
      for (const row of fx.inbox.listOpen()) {
        await fx.inbox.answer(row.id, { action: 'word', text: 'go' }, { kind: 'person' });
      }
      const byKey = new Map(fx.inbox.listOpen().map((row) => [row.key, row.watch]));
      expect(byKey.get('mine')).toEqual({
        sessionId: started.sessionId,
        label: 'Sorting 12 ideas…',
      });
      expect(byKey.get('theirs')).toBeNull();
    } finally {
      fx.inbox.stop();
      fx.close();
    }
  });
});
