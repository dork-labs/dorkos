/** Acknowledged draft settings through the owned Hono routes, SQLite and real adapters. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eq,
  sessionBirthAllocations,
  sessionDraftSources,
  sessionLocations,
  sessionMessageQueue,
  sessionMetadata,
  sessionNativeBindings,
} from '@dorkos/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { initBoundary } from '../../lib/boundary.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  createChatRiseFacts,
  setChatRiseFacts,
} from '../../services/core/turn-power/chat-rise-facts.js';
import { CodexRuntime } from '../../services/runtimes/codex/codex-runtime.js';
import { CodexSessionRegistry } from '../../services/runtimes/codex/session-registry.js';
import { CodexThreadMap } from '../../services/runtimes/codex/thread-map.js';
import { DoeRuntime } from '../../services/runtimes/doe/doe-runtime.js';
import { TestModeSessionRegistry } from '../../services/runtimes/test-mode/session-registry.js';
import { TestModeRuntime } from '../../services/runtimes/test-mode/test-mode-runtime.js';
import { createSessionLocationsRoutes } from '../session-locations.js';
import { createSessionRoutes } from '../sessions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

let root: string;
let cwd: string;
let codex: CodexRuntime;
let threads: CodexThreadMap;
let doe: DoeRuntime;
const resolveBinary = vi.fn(async () => {
  throw new Error('Prepared settings must not start Codex');
});
const inference = vi.fn(() => {
  throw new Error('Prepared settings must not resolve Doe inference');
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'prepared-runtime-settings-')));
  cwd = join(root, 'project');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const dorkHome = join(root, 'dork-home');
  await Promise.all([cwd, home, codexHome, dorkHome].map((dir) => mkdir(dir, { mode: 0o700 })));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  await initBoundary(root);
});

const harness = frontDoorStepUpHarness(() => {
  const db = harness.db();
  threads = new CodexThreadMap(db);
  codex = new CodexRuntime({
    threadMap: threads,
    defaultCwd: cwd,
    transport: 'exec',
    resolveBinary,
  });
  doe = new DoeRuntime({ directory: join(root, 'doe-state'), defaultCwd: cwd, inference });
  runtimeRegistry.setDb(db);
  for (const runtime of [codex, doe, new TestModeRuntime(), new TestModeRuntime('test-mode-b')]) {
    runtime.setSessionSettings(runtimeRegistry);
    runtimeRegistry.register(runtime);
  }
  setChatRiseFacts(createChatRiseFacts(db));
  return [
    { path: '/api/session-locations', routes: createSessionLocationsRoutes(db) },
    { path: '/api/sessions', routes: createSessionRoutes({ personBirthDb: db }) },
  ];
});

afterAll(async () => {
  setChatRiseFacts(null);
  await Promise.all([codex?.shutdown(), doe?.shutdown()]);
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function allocateChat() {
  const location = await harness.call('post', '/api/session-locations').send({ cwd });
  expect([200, 201]).toContain(location.status);
  const saved = harness
    .db()
    .select()
    .from(sessionLocations)
    .where(eq(sessionLocations.id, location.body.id))
    .get();
  if (!saved) throw new Error('Expected a saved location from the authenticated route');
  const ack = await harness.call('post', `/api/session-locations/${saved.id}/chats`).send({});
  expect(ack.status).toBe(201);
  expect(ack.body).toMatchObject({ launchRef: saved.id, sessionId: expect.any(String) });
  const id: string = ack.body.sessionId;
  return { id, saved };
}

function read(id: string) {
  const db = harness.db();
  return {
    metadata: db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get(),
    allocation: db
      .select()
      .from(sessionBirthAllocations)
      .where(eq(sessionBirthAllocations.sessionId, id))
      .get(),
    source: db
      .select()
      .from(sessionDraftSources)
      .where(eq(sessionDraftSources.sessionId, id))
      .get(),
    queue: db.select().from(sessionMessageQueue).where(eq(sessionMessageQueue.sessionId, id)).all(),
    native: db
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, id))
      .all(),
  };
}

it.each([
  ['codex', 'default'],
  ['doe', 'default'],
  ['test-mode', 'always-allow'],
  ['test-mode-b', 'always-allow'],
])(
  '%s commits settings on the acknowledged draft only while its source matches',
  async (type, mode) => {
    // Runtime hints validate the requested fields. Actual routing remains the
    // registry's existing unbound inference, which this fixture selects.
    runtimeRegistry.setDefault(type);
    const { id, saved } = await allocateChat();
    const db = harness.db();
    const update = (patch: Record<string, boolean | string>) =>
      harness.call('patch', `/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`).send(patch);
    const requested = { runtime: type, permissionMode: mode, fastMode: false };
    const before = read(id);
    expect(before).toEqual({
      metadata: undefined,
      allocation: expect.objectContaining({ sessionId: id, locationId: saved.id }),
      source: undefined,
      queue: [],
      native: [],
    });

    const codexPublication = vi.spyOn(CodexSessionRegistry.prototype, 'register');
    const testPublication = vi.spyOn(TestModeSessionRegistry.prototype, 'applySettings');
    const transactionWrite = vi.fn();
    db.$client.function('observe_prepared_runtime_insert', (sessionId: string) => {
      transactionWrite(sessionId);
      return 1;
    });
    try {
      const unsupported = await update({ ...requested, permissionMode: 'unknown-fixture-mode' });
      expect(unsupported.status).toBe(400);
      expect(unsupported.body).toMatchObject({ code: 'invalid_request' });
      expect(read(id)).toEqual(before);

      // The write reaches SQLite. Replacing the source generation inside that
      // transaction must roll back the settings and prevent local publication.
      db.$client.exec(`
      CREATE TEMP TRIGGER reject_prepared_runtime_insert AFTER INSERT ON session_metadata
      WHEN NEW.session_id = '${id}'
      BEGIN
        SELECT observe_prepared_runtime_insert(NEW.session_id);
        UPDATE session_locations SET created_at = 'changed-in-fixture' WHERE id = '${saved.id}';
      END
    `);
      try {
        const refused = await update(requested);
        expect(transactionWrite).toHaveBeenCalledExactlyOnceWith(id);
        expect(refused.status).toBe(404);
        expect(refused.body).toMatchObject({ code: 'session_not_found' });
        expect(read(id)).toEqual(before);
        expect(codexPublication).not.toHaveBeenCalled();
        expect(testPublication).not.toHaveBeenCalled();
      } finally {
        db.$client.exec('DROP TRIGGER reject_prepared_runtime_insert');
      }

      const accepted = await update(requested);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        id,
        runtime: type,
        runtimeUnbound: true,
        permissionMode: mode,
      });
      const draft = read(id);
      expect(draft).toMatchObject({
        metadata: {
          sessionId: id,
          runtime: null,
          modelLaunchState: 'pending-v1',
          permissionMode: mode,
          permissionModeByPerson: true,
          fastMode: false,
        },
        allocation: undefined,
        source: {
          sessionId: id,
          ownerId: saved.ownerId,
          sourceKind: 'person-location',
          locationId: saved.id,
          sourcePath: saved.cwd,
          sourceCreatedAt: saved.createdAt,
        },
        queue: [],
        native: [],
      });
      if (type === 'codex') {
        expect(codexPublication).toHaveBeenCalledExactlyOnceWith(id, {
          permissionMode: mode,
          fastMode: false,
        });
        expect(testPublication).not.toHaveBeenCalled();
      } else if (type.startsWith('test-mode')) {
        expect(testPublication).toHaveBeenCalledExactlyOnceWith(id, { permissionMode: mode });
        expect(codexPublication).not.toHaveBeenCalled();
      } else {
        expect(codexPublication).not.toHaveBeenCalled();
        expect(testPublication).not.toHaveBeenCalled();
      }

      const repeat = await update({ fastMode: true });
      expect(repeat.status).toBe(200);
      expect(read(id)).toEqual({ ...draft, metadata: { ...draft.metadata, fastMode: true } });
      expect(threads.get(id)).toBeUndefined();
      expect(doe.hasSession(id)).toBe(false);
      expect(() => doe.sessions.models.metadata(id)).toThrow('Unknown session');
      expect(resolveBinary).not.toHaveBeenCalled();
      expect(inference).not.toHaveBeenCalled();
    } finally {
      codexPublication.mockRestore();
      testPublication.mockRestore();
    }
  }
);
