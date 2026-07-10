import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { OpenCodeSessionMap } from '../session-map.js';
import { OpenCodeSessionMapper, type OpenCodeClientProvider } from '../session-mapper.js';
import { logger } from '../../../../lib/logger.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OC_ID = 'ses_abc123';
const OTHER_OC_ID = 'ses_def456';
const PROJECT_DIR = '/work/project';

describe('OpenCodeSessionMap', () => {
  let db: Db;
  let map: OpenCodeSessionMap;

  beforeEach(() => {
    db = createTestDb();
    map = new OpenCodeSessionMap(db);
  });

  it('round-trips bind then listAll', () => {
    map.bind(SESSION_ID, OC_ID);
    expect(map.listAll()).toEqual([{ sessionId: SESSION_ID, ocSessionId: OC_ID }]);
  });

  it('replaces the row when the same DorkOS session re-binds (authoritative, strictly 1:1)', () => {
    map.bind(SESSION_ID, OC_ID);
    map.bind(SESSION_ID, OTHER_OC_ID);
    expect(map.listAll()).toEqual([{ sessionId: SESSION_ID, ocSessionId: OTHER_OC_ID }]);
  });

  it('replaces the row when the same OpenCode session re-binds — a derived adoption is superseded', () => {
    map.bind(SESSION_ID, OC_ID);
    map.bind(OTHER_SESSION_ID, OC_ID);
    expect(map.listAll()).toEqual([{ sessionId: OTHER_SESSION_ID, ocSessionId: OC_ID }]);
  });

  it('stores independent bindings for different sessions', () => {
    map.bind(SESSION_ID, OC_ID);
    map.bind(OTHER_SESSION_ID, OTHER_OC_ID);
    expect(map.listAll()).toHaveLength(2);
  });

  describe('persistence failure (the never-throws contract)', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // A real failure, not a mocked one: closing the underlying better-sqlite3
      // connection makes every subsequent statement throw.
      db.$client.close();
      warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    it('bind() warns and returns normally instead of throwing', () => {
      expect(() => map.bind(SESSION_ID, OC_ID)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist session binding'),
        expect.objectContaining({ sessionId: SESSION_ID, ocSessionId: OC_ID })
      );
    });

    it('listAll() warns and degrades to an empty hydration set instead of throwing', () => {
      expect(map.listAll()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to read persisted session bindings'),
        expect.anything()
      );
    });

    it('the mapper stays fully functional in-memory over a broken store', async () => {
      const provider = createProvider();

      // Construction hydrates via listAll() — must not crash boot.
      const mapper = new OpenCodeSessionMapper(provider, map);

      // Creating a session write-throughs via bind() — must not break the turn.
      await expect(mapper.ensureSession(SESSION_ID, { cwd: PROJECT_DIR })).resolves.toBe(OC_ID);
      expect(mapper.getOpenCodeSessionId(SESSION_ID)).toBe(OC_ID);

      // The in-memory binding still serves listing under the original id —
      // only restart durability degrades.
      const sessions = await mapper.listSessions(PROJECT_DIR);
      expect(sessions.map((s) => s.id)).toEqual([SESSION_ID]);
    });
  });
});

/** Sidecar mock: create() mints OC_ID, list() re-surfaces it (the restart re-list). */
function createProvider(): OpenCodeClientProvider {
  const ocSession = {
    id: OC_ID,
    projectID: 'prj_1',
    directory: PROJECT_DIR,
    title: 'Survives restarts',
    version: '1.17.13',
    time: { created: 1_751_400_000_000, updated: 1_751_403_600_000 },
  };
  const client = {
    session: {
      create: vi.fn(async () => ({ data: ocSession })),
      list: vi.fn(async () => ({ data: [ocSession] })),
    },
  } as unknown as OpencodeClient;
  return { getClient: async () => client, peekClient: () => client };
}

describe('OpenCodeSessionMapper + OpenCodeSessionMap (restart stability, DOR-251)', () => {
  it('re-lists the same OpenCode session under its ORIGINAL DorkOS id after a restart', async () => {
    const db = createTestDb();
    const provider = createProvider();

    // Server lifetime 1: a DorkOS-created session binds the client UUID.
    const mapper = new OpenCodeSessionMapper(provider, new OpenCodeSessionMap(db));
    await expect(mapper.ensureSession(SESSION_ID, { cwd: PROJECT_DIR })).resolves.toBe(OC_ID);

    // Server lifetime 2: fresh mapper, same database — the restart analog.
    // Pre-fix this re-list minted a NEW derived (v5) id and the original
    // 404'd forever; the durable map now re-associates the original id.
    const restarted = new OpenCodeSessionMapper(provider, new OpenCodeSessionMap(db));
    const sessions = await restarted.listSessions(PROJECT_DIR);

    expect(sessions.map((s) => s.id)).toEqual([SESSION_ID]);
    expect(restarted.getOpenCodeSessionId(SESSION_ID)).toBe(OC_ID);
  });
});
