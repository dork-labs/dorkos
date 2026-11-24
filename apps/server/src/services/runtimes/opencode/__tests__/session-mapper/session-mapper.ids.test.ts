/**
 * session-mapper: ids. Shared setup lives in `./session-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeSessionMapper } from '../../sessions/session-mapper.js';
import {
  PROJECT_DIR,
  DORKOS_ID,
  ocSession,
  userMessage,
  textPart,
  createMockClient,
  createProvider,
} from './session-mapper.fixtures.js';

// SDK-only access guard (ADR-0308: OpenCode's store is opaque, runtime-owned).
// The mapper must reach session data exclusively through the SDK client — if it
// (or anything in its runtime import graph) ever imports the filesystem, these
// throwing factories fail the suite at module load.
//
// A `vi.mock` reaches the WHOLE module graph, not just the mapper's, so the
// vectors above come from their own subpath rather than the `@dorkos/test-utils`
// barrel. The barrel re-exports the runtime conformance suite, which legitimately
// resolves real paths, and pulling it in here would fail this file for something
// that is not the mapper and not in the mapper's graph at all.
vi.mock('node:fs', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

vi.mock('node:fs/promises', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

describe('OpenCodeSessionMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureSession', () => {
    it('creates the OpenCode session with the per-session cwd as directory', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const openCodeId = await mapper.ensureSession(DORKOS_ID, {
        cwd: PROJECT_DIR,
        title: 'Hello',
      });

      expect(openCodeId).toBe('ses_new');
      expect(client.session.create).toHaveBeenCalledWith({
        body: { title: 'Hello' },
        query: { directory: PROJECT_DIR },
      });
      expect(mapper.getOpenCodeSessionId(DORKOS_ID)).toBe('ses_new');
    });
  });
});

describe('OpenCodeSessionMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('durable id stability (DOR-251)', () => {
    /** In-memory OpenCodeSessionMapStore fake with the replace-on-either-key contract. */
    function createFakeStore() {
      const rows = new Map<string, string>(); // sessionId -> ocSessionId
      return {
        rows,
        bind: vi.fn((sessionId: string, ocSessionId: string) => {
          for (const [sid, oid] of [...rows]) {
            if (sid === sessionId || oid === ocSessionId) rows.delete(sid);
          }
          rows.set(sessionId, ocSessionId);
        }),
        listAll: vi.fn(() =>
          [...rows].map(([sessionId, ocSessionId]) => ({ sessionId, ocSessionId }))
        ),
      };
    }

    it('writes a created binding through to the durable store', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      const store = createFakeStore();
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);

      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      expect(store.bind).toHaveBeenCalledWith(DORKOS_ID, 'ses_new');
    });

    it('a restarted mapper re-lists the same OpenCode session under its ORIGINAL DorkOS id', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_abc123' })] });
      const store = createFakeStore();

      // Server lifetime 1: DorkOS-created session binds the client UUID.
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      // Server lifetime 2: fresh mapper hydrated from the durable store. The
      // pre-fix behavior minted a NEW derived (v5) UUID here, permanently
      // 404ing the original id (DOR-251).
      const restarted = new OpenCodeSessionMapper(createProvider(client), store);
      const sessions = await restarted.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.id)).toEqual([DORKOS_ID]);
      expect(restarted.getOpenCodeSessionId(DORKOS_ID)).toBe('ses_abc123');
    });

    it('serves history under the original id after a restart without a rebuild re-list', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hello again')] }],
      });
      const store = createFakeStore();

      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const restarted = new OpenCodeSessionMapper(createProvider(client), store);
      const history = await restarted.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_abc123' } });
      expect(history[0]!.content).toBe('hello again');
      // The hydrated binding resolved directly — no recovery re-list needed.
      expect(client.session.list).not.toHaveBeenCalled();
    });
  });
});
