/**
 * Starting work in a new chat (spec `flow-multiproject` §7.7): one start
 * launches one chat in the project's root with its title and the prompt as its
 * first message, and the chat says who started it on the session list and the
 * live stream. A folder outside every project, a project the extension may not
 * see, an ineligible account, the hourly limit and the running limit each
 * refuse and launch nothing. The limits survive a restart and count chats
 * started from started chats.
 *
 * A start goes through the real turn port (spec `turns-survive-restarts` §3):
 * the space face saves its run over the test database, and a case moves the
 * run as the dispatcher would, so a start can be observed without a runtime.
 * Everything else is real, down to the table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Session } from '@dorkos/shared/types';
import { SessionStartedBySchema } from '@dorkos/shared/schemas';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ProjectInfo, ProjectRef } from '@dorkos/extension-api/server';
import { START_WORK_LIMITS } from '@dorkos/shared/extension-decision-schemas';
import { createMockSession } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { StartTurnInput } from '@dorkos/shared/turn-port';
import {
  createRunFactsSink,
  createRunRecord,
  getRunRecord,
  installRunRecord,
  uninstallRunRecord,
  type RunRecord,
} from '../../runs/index.js';
import { eq, notifications as notificationsTable } from '@dorkos/db';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
// Wires the projector's rekey hooks (the queue and its runs follow a moved chat).
import '../../session/message-dispatcher.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  rekeyProjector,
} from '../../session/session-state-projector.js';
import { queueKeyOf } from '../../session/resolution/session-key-registry.js';
import { holdRun, releaseRun } from '../../session/turn-port/facts.js';

import { applySessionOriginOverlays } from '../../session/origin/session-origin-overlays.js';
import { _forgetTitles } from '../../session/origin/started-by-origin-overlay.js';
import { SessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { StartWorkService, setStartWorkService, type StartWorkDeps } from '../start-work.js';
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
let record: RunRecord;
/** Every start the turn port saved, with its run's id, in order. */
let launches: Array<StartTurnInput & { runId: string }>;
/** Admission's launch cap, as a switch. */
let machineFull: boolean;

/** Let the record's watchers hear what just moved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** A start's turn ran and ended, as the dispatcher writes it. */
async function finish(index: number): Promise<void> {
  const { store } = record;
  let run = store.get(launches[index]!.runId)!;
  run = store.move(run, 'starting', store.lease());
  run = store.move(run, 'started', { startedAt: store.stamp(), runtime: 'test-mode' });
  store.endTurn(run, 'completed');
  await flush();
}

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
    port: () => record.port,
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
  db = createTestDb();
  machineFull = false;
  record = createRunRecord(db, {
    epoch: '01BOOTEPOCHSTARTWORK000000',
    admission: { admission: { pausedAgent: () => undefined, machineFull: () => machineFull } },
  });
  launches = [];
  const start = record.port.start.bind(record.port);
  vi.spyOn(record.port, 'start').mockImplementation((input) => {
    const answer = start(input);
    launches.push({ ...input, runId: answer.runId });
    return answer;
  });
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
  it('starts one chat in the project root, with its title and the prompt as its first message', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');

    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expect(launch).toMatchObject({
      sessionId,
      origin: { kind: 'extension-start' },
      content: INPUT.prompt,
      cwd: DORKOS.root,
      tier: 'owner',
      // One honest line for the model; the prompt stays byte for byte.
      seedContext: `This chat was started by the Flow extension: ${INPUT.reason}`,
    });
    expect(launch).not.toHaveProperty('permissionCeiling');
    // On the runtime the account rule was checked for, by name.
    expect(launch).toMatchObject({ runtime: 'test-mode' });
    // Saved as a run, waiting for its hand-over: the answer came at acceptance.
    expect(record.store.get(launch!.runId)).toMatchObject({ status: 'queued', sessionId });
    // No title on a chat whose turn has not begun: a start that waits or is
    // cancelled leaves no titled empty chat.
    expect(renamed).toEqual([]);
    expect(store.get(sessionId)).toMatchObject({
      kind: 'extension',
      extensionId: 'flow',
      originExtensionId: 'flow',
      startedBySessionId: null,
      reason: INPUT.reason,
    });
  });

  it('passes a Wi-Fi sign-in’s bound on (DOR-3037)', async () => {
    await service.start('flow', INPUT, 'ctx', { permissionCeiling: 'runtime-default' });
    expect(launches[0]!.permissionCeiling).toBe('runtime-default');
    expect(record.effects.listForRun(launches[0]!.runId)[0]?.payload).toMatchObject({
      permissionCeiling: 'runtime-default',
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

  it('keeps who started it when the runtime settles on another id', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    // The chat's runs move with its queue to the id the runtime settled on.
    record.store.rekeyChat(sessionId, `sdk-${sessionId}`);
    await finish(0);
    expect(store.get(`sdk-${sessionId}`)?.extensionId).toBe('flow');
    expect(store.get(sessionId)).toBeNull();
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
      expect(launches[0]!.cwd).toBe(DORKOS.root);
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
      await finish(launches.length - 1);
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

    await finish(0);
    await expect(service.start('flow', INPUT, 'ctx')).resolves.toBeTruthy();
  });

  it('forgets a start the launch’s own account check refused at the door', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(1);
    // The door refuses it after acceptance, and the run is cancelled with why.
    record.starts.cancel(launches[0]!.runId, 'account_not_allowed');
    await flush();
    expect(record.store.get(launches[0]!.runId)?.endingDetail.cancelledBecause).toBe(
      'account_not_allowed'
    );
    expect(store.get(sessionId)).toBeNull();
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('waits, rather than refuses, when the machine-wide cap is full', async () => {
    machineFull = true;
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    expect(record.store.get(launches[0]!.runId)).toMatchObject({
      status: 'queued',
      waitReason: 'machine_full',
    });
    // Still a start: it counts until it runs or is cancelled.
    expect(store.get(sessionId)?.extensionId).toBe('flow');
  });
});

describe('the limits', () => {
  it('survive a restart: the hourly count is read from the table', async () => {
    for (let i = 0; i < START_WORK_LIMITS.perHour; i++) {
      await service.start('flow', INPUT, 'ctx');
      await finish(launches.length - 1);
    }
    // A new process: nothing in memory, the same database.
    const restarted = build();
    expect((await refusal(restarted.start('flow', INPUT, 'ctx'))).code).toBe('start_limit');
  });

  it('count chats started from a started chat', async () => {
    const parent = await service.start('flow', INPUT, 'ctx');
    await finish(launches.length - 1);
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

  it('carries the level a chat was started at, and whether it matched the starter', () => {
    for (const [sessionId, mode, same] of [
      ['child-same', 'bypassPermissions', true],
      ['child-lower', 'acceptEdits', false],
    ] as const) {
      store.insert({
        sessionId,
        kind: 'chat',
        extensionId: null,
        startedBySessionId: 'parent-1',
        originExtensionId: null,
        reason: null,
        permissionMode: mode,
        starterPermissionMode: 'bypassPermissions',
        permissionSameAsStarter: same,
        createdAt: new Date(clock).toISOString(),
      });
    }
    const rows = [
      createMockSession({ id: 'child-same', title: 'A' }),
      createMockSession({ id: 'child-lower', title: 'B' }),
    ];
    applySessionOriginOverlays(rows, { resolveStartedBy: (ids) => store.getMany(ids) });
    expect(rows[0]!.startedBy).toMatchObject({
      permission: { mode: 'bypassPermissions', sameAsStarter: true },
    });
    expect(rows[1]!.startedBy).toMatchObject({
      permission: { mode: 'acceptEdits', sameAsStarter: false },
    });
    // The wire schema accepts what the overlay writes.
    for (const row of rows)
      expect(SessionStartedBySchema.parse(row.startedBy)).toEqual(row.startedBy);
  });

  it('keeps the recorded level when a started chat is carried to another account', () => {
    store.insert({
      sessionId: 'started',
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'parent-1',
      originExtensionId: null,
      reason: 'split the work',
      permissionMode: 'plan',
      starterPermissionMode: 'acceptEdits',
      permissionSameAsStarter: false,
      createdAt: new Date(clock).toISOString(),
    });
    const claimed = service.reserveFromChat({
      sessionId: 'carried',
      parentSessionId: 'started',
      carry: true,
    });
    expect(claimed.ok).toBe(true);
    expect(store.get('carried')).toMatchObject({
      permissionMode: 'plan',
      starterPermissionMode: 'acceptEdits',
      permissionSameAsStarter: false,
    });
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

describe('a start through the turn port (DOR-5232)', () => {
  it('saves its words with the start, hands them over again after a restart, and lets them go once used', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    const run = record.store.get(launches[0]!.runId)!;
    expect(run.sourceRef).toBe(`start-work:${sessionId}`);
    expect(store.get(sessionId)?.prompt).toBe(INPUT.prompt);

    // A restart: a new run record and seam over the same database. The words
    // are no longer in any process, only in the start's own row.
    record = createRunRecord(db, { epoch: '01BOOTEPOCHSTARTWORK000001' });
    service = build();
    expect(record.port.wordsOf(run)).toBe(INPUT.prompt);

    // Once its turn has them, the row lets them go.
    launches[0] = { ...launches[0]!, runId: run.id };
    await finish(0);
    expect(store.get(sessionId)?.prompt).toBeNull();
  });

  it('tells the owner once, naming the app and why, when a start it answered never runs', async () => {
    const notifications = new NotificationStore(db);
    setNotificationService(new NotificationService(notifications));
    try {
      await service.start('flow', INPUT, 'ctx');
      const { runId } = launches[0]!;
      // The door refused it after the answer: the account rule.
      record.starts.cancel(runId, 'account_not_allowed');
      expect(record.effects.listForRun(runId).filter((e) => e.kind === 'notify_person')).toEqual([
        expect.objectContaining({
          key: `notify:${runId}:not_started`,
          payload: expect.objectContaining({ name: 'Flow', reason: 'account_not_allowed' }),
        }),
      ]);
      await record.worker.runOnce();
      const rows = db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.kind, 'extension.work_not_started'))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: 'The Flow app couldn’t start its chat',
        body: 'No account may work in that project.',
      });
      // Told once: a second pass writes nothing.
      await record.worker.runOnce();
      expect(
        db
          .select()
          .from(notificationsTable)
          .where(eq(notificationsTable.kind, 'extension.work_not_started'))
          .all()
      ).toHaveLength(1);
    } finally {
      setNotificationService(null);
    }
  });

  it('carries a launch warning on its history until the chat shows its run (T3)', async () => {
    const emit = vi.fn(async () => undefined);
    service = build({ activity: { emit } as never });
    await service.start('flow', INPUT, 'ctx');
    const { runId } = launches[0]!;
    const { store: runs } = record;
    // This process holds the launch, as the dispatcher does while it runs.
    holdRun(runId);
    runs.move(runs.get(runId)!, 'starting', runs.lease());
    createRunFactsSink(runs, record.notices, record.starts).report({
      kind: 'started',
      runId,
      sessionId: launches[0]!.sessionId,
      openedBy: 'caller',
      runtime: 'codex',
      runtimeTurnRef: 1,
      warnings: [{ code: 'NO_DORKOS_TOOLS', message: 'This chat has no DorkOS tools.' }],
    });
    releaseRun(runId);
    await flush();
    expect(runs.get(runId)?.warnings).toEqual([
      { code: 'NO_DORKOS_TOOLS', message: 'This chat has no DorkOS tools.' },
    ]);
    expect(
      emit.mock.calls.map(
        (call) => (call as unknown as [{ eventType: string; summary: string }])[0]
      )
    ).toEqual([
      expect.objectContaining({ eventType: 'extension.session_started' }),
      expect.objectContaining({
        eventType: 'extension.session_warning',
        summary: `Flow's chat ${INPUT.title}: This chat has no DorkOS tools.`,
      }),
    ]);
  });

  it('keeps opening the chat by the id it answered, after the runtime moves the chat', async () => {
    // The server's own wiring: the run record as the facts sink, and the queue
    // whose rekey moves a chat's runs.
    uninstallRunRecord();
    installRunRecord(db, { epoch: '01BOOTEPOCHSTARTWORK000002' });
    record = getRunRecord()!;
    setMessageQueueStore(new MessageQueueStore(db));
    try {
      const { sessionId } = await service.start('flow', INPUT, 'ctx');
      getOrCreateProjector(sessionId, DORKOS.root);
      const canonical = `sdk-${sessionId}`;
      rekeyProjector(sessionId, canonical);

      // The id the app was given still reaches the chat, its projector and its run.
      expect(queueKeyOf(sessionId)).toBe(queueKeyOf(canonical));
      expect(peekProjector(sessionId)).toBe(peekProjector(canonical));
      expect(record.port.list(sessionId).map((run) => run.id)).toEqual([
        record.port.list(canonical)[0]!.id,
      ]);

      // Its first turn runs: who started it moves with it, and the title is set.
      const { store: runs } = record;
      const run = runs.listForChat(canonical)[0]!;
      holdRun(run.id);
      runs.move(run, 'starting', runs.lease());
      createRunFactsSink(runs).report({
        kind: 'started',
        runId: run.id,
        sessionId: canonical,
        openedBy: 'caller',
        runtime: 'test-mode',
        runtimeTurnRef: 1,
      });
      releaseRun(run.id);
      await flush();
      expect(store.get(canonical)?.extensionId).toBe('flow');
      expect(store.get(sessionId)).toBeNull();
      // Titled once its turn began, under the id it runs under, on its runtime.
      expect(renamed).toEqual([
        { runtime: 'test-mode', sessionId: canonical, title: INPUT.title, cwd: DORKOS.root },
      ]);
      disposeProjector(canonical);
    } finally {
      uninstallRunRecord();
      setMessageQueueStore(undefined);
    }
  });
});

describe('a start a pause cuts after its first event (DOR-5232)', () => {
  it('keeps its words through the cut, runs once on resume, and tells nobody it could not start', async () => {
    const { sessionId } = await service.start('flow', INPUT, 'ctx');
    const { runId } = launches[0]!;
    const { store: runs } = record;
    const sink = createRunFactsSink(runs, record.notices, record.starts);
    const startOnce = (ref: number) => {
      runs.move(runs.get(runId)!, 'starting', runs.lease());
      sink.report({
        kind: 'started',
        runId,
        sessionId,
        openedBy: 'caller',
        runtime: 'test-mode',
        runtimeTurnRef: ref,
      });
      sink.report({ kind: 'delivered', runId });
    };
    holdRun(runId);
    startOnce(1);
    // Every watcher hears the run running before the pause lands.
    await flush();
    // A pause lands after the runtime's first event, before the agent acted: 15.
    sink.dispatcher.pauseCut(runId);
    await flush();
    expect(runs.get(runId)?.status).toBe('queued');
    // The words are still there to hand over again: in the row and in memory.
    expect(store.get(sessionId)?.prompt).toBe(INPUT.prompt);
    expect(record.port.wordsOf(runs.get(runId)!)).toBe(INPUT.prompt);
    // Resumed: it runs once, and ends.
    startOnce(2);
    runs.endTurn(runs.get(runId)!, 'completed');
    releaseRun(runId);
    await flush();
    expect(runs.get(runId)?.status).toBe('ended');
    expect(store.get(sessionId)?.prompt).toBeNull();
    expect(
      record.effects
        .listForRun(runId)
        .filter((e) => e.kind === 'notify_person' && e.key.endsWith(':not_started'))
    ).toEqual([]);
  });
});
