/**
 * session-mapper: list. Shared setup lives in `./session-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils/directory-membership-vectors';
import { OpenCodeSessionMapper } from '../../sessions/session-mapper.js';
import { SESSION_LIST_LIMIT } from '../../runtime-constants.js';
import { expectNoDorkMarkup } from '../../../shared/__tests__/no-dork-markup.js';
import {
  PROJECT_DIR,
  UUID_RE,
  CREATED_MS,
  UPDATED_MS,
  ocSession,
  createMockClient,
  serveSessions,
  serveWithCapIgnoringLimit,
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

  describe('listSessions', () => {
    it('returns [] immediately without booting when no sidecar is running', async () => {
      const provider = createProvider(null);
      const mapper = new OpenCodeSessionMapper(provider);

      await expect(mapper.listSessions(PROJECT_DIR)).resolves.toEqual([]);
      // A cold sidecar must never block the aggregated session list.
      expect(provider.getClient).not.toHaveBeenCalled();
    });

    it('shows a title OpenCode stored from a greeting kickoff as untitled (DOR-4976)', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession({ title: '<dork-kickoff>' })]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const [session] = await mapper.listSessions(PROJECT_DIR);

      expectNoDorkMarkup(session);
      expect(session!.title).toBe('');
    });

    it('lists via the SDK and maps sessions tagged runtime "opencode"', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(client.session.list).toHaveBeenCalledWith({
        query: {
          directory: PROJECT_DIR,
          roots: true,
          limit: SESSION_LIST_LIMIT + 1,
          scope: 'project',
        },
      });
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.runtime).toBe('opencode');
      expect(session.id).toMatch(UUID_RE);
      expect(session.title).toBe('Fix the flaky test');
      expect(session.createdAt).toBe(new Date(CREATED_MS).toISOString());
      expect(session.updatedAt).toBe(new Date(UPDATED_MS).toISOString());
      expect(session.cwd).toBe(PROJECT_DIR);
      expect(session.permissionMode).toBe('default');
    });

    it('lists a session started in a SUBFOLDER of the open project (DOR-674)', async () => {
      const client = createMockClient();
      // The bug: `opencode` run in a subfolder stores THAT folder on the
      // session, and the sidecar's `?directory=` filter is exact string
      // equality — so this session appeared in no project's list at all.
      serveSessions(client, [
        ocSession({ id: 'ses_root', title: 'at the top' }),
        ocSession({
          id: 'ses_sub',
          title: 'in a subfolder',
          directory: `${PROJECT_DIR}/packages/api`,
        }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.title)).toEqual(['at the top', 'in a subfolder']);
      // The row keeps its OWN folder, so it still says where it is running.
      expect(sessions[1]!.cwd).toBe(`${PROJECT_DIR}/packages/api`);
    });

    it('keeps a sibling folder that merely shares a prefix out of the list (DOR-674)', async () => {
      const client = createMockClient();
      // `/work/project-2` starts with `/work/project` as a STRING but is a
      // different project — the exact trap a raw `startsWith` walks into.
      serveSessions(client, [
        ocSession({ id: 'ses_mine', title: 'mine' }),
        ocSession({ id: 'ses_sibling', title: 'sibling', directory: `${PROJECT_DIR}-2/src` }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.title)).toEqual(['mine']);
    });

    it('asks for more than the sidecar default of 100, so session 101+ still list (DOR-673)', async () => {
      const client = createMockClient();
      // The live sidecar returns only the 100 most-recently-updated sessions
      // when no `limit` is sent — silently, with no error and no marker. The
      // request is the only place the adapter can prevent that.
      serveSessions(
        client,
        Array.from({ length: 150 }, (_, i) => ocSession({ id: `ses_${i}` }))
      );
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      const query = client.session.list.mock.calls[0]![0]!.query;
      expect(query.limit).toBe(SESSION_LIST_LIMIT + 1);
      expect(query.limit).toBeGreaterThan(100);
      expect(sessions).toHaveLength(150);
    });

    describe.each(DIRECTORY_MEMBERSHIP_VECTORS.filter((v) => v.root.startsWith('/')))(
      'membership vector: $name',
      ({ root, candidate, within }) => {
        it(`${within ? 'lists' : 'omits'} it`, async () => {
          // The adapter answers the SAME table as the server's per-agent
          // fan-out and the client's selector — one rule, three call sites
          // (DOR-674). Only POSIX-absolute roots run here: this call site
          // additionally REQUIRES an absolute path (covered just above), and
          // `C:\…` is not absolute to a POSIX `path.isAbsolute`. The Windows
          // spellings are driven where a Windows `cwd` actually crosses a
          // boundary — the predicate's own suite and the client selector's.
          const client = createMockClient();
          serveSessions(client, [ocSession({ id: 'ses_candidate', directory: candidate })]);
          const mapper = new OpenCodeSessionMapper(createProvider(client));

          const sessions = await mapper.listSessions(root);

          expect(sessions).toHaveLength(within ? 1 : 0);
        });
      }
    );

    it('rejects when the sentinel row proves sessions were left behind (DOR-673)', async () => {
      const client = createMockClient();
      // One MORE than the budget came back, which can only mean the read was
      // truncated. There is no offset cursor to fetch the remainder, so
      // aggregation turns the rejection into a per-runtime warning (ADR-0310)
      // instead of a plausible short list.
      client.session.list.mockResolvedValue({
        data: Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) =>
          ocSession({ id: `ses_${i}` })
        ),
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/could not read far enough/);
    });

    it('will not claim a 3-session project is complete when the MACHINE is saturated (DOR-674)', async () => {
      const client = createMockClient();
      // The budget is spent on the widened, machine-wide read now. A machine
      // holding more sessions than DorkOS can read past means the widened page
      // was cut off somewhere — and the cut could have landed on this project's
      // subfolder sessions, so a short list here would be a confident lie.
      const elsewhere = Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) =>
        ocSession({ id: `ses_other_${i}`, directory: `/somewhere/else/${i}` })
      );
      serveSessions(client, [
        ocSession({ id: 'ses_1' }),
        ocSession({ id: 'ses_2' }),
        ocSession({ id: 'ses_3' }),
        ...elsewhere,
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      // Degrades to a per-runtime warning (ADR-0310), which is the honest
      // answer; it must NOT return the 3 rows it happened to see.
      await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/on this machine/);
    });

    // Any cap, not one blessed value: a sidecar that dropped `limit` AND moved
    // its default would walk straight through a check pinned to 100. 50 and
    // 120 are the caps such a check misses; 100 is today's.
    it.each([50, 100, 120])(
      'rejects a sidecar that ignores `limit` and re-caps at %i',
      async (cap) => {
        const client = createMockClient();
        const sessions = Array.from({ length: 150 }, (_, i) => ocSession({ id: `ses_${i}` }));
        serveWithCapIgnoringLimit(client, sessions, cap);
        const mapper = new OpenCodeSessionMapper(createProvider(client));

        await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/ignored the chat limit/);
        const probe = client.session.list.mock.calls[1]![0]!.query;
        expect(probe.limit).toBe(1);
        // The probe must ask the SAME question the real read asks. A sidecar
        // that honoured `limit` for a narrow read but dropped it for the
        // widened one would clear a probe that never widens — the exact
        // probe-drift the method's own TSDoc warns about.
        expect(probe.scope).toBe('project');
      }
    );

    it('refuses a project path that is not a full folder path, out loud', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      // The membership rule will not guess a working directory, so a relative
      // path would match nothing and read as "this project has no OpenCode
      // sessions". Aggregation turns the rejection into a warning that says so.
      await expect(mapper.listSessions('work/project')).rejects.toThrow(/full folder path/);
    });
  });
});
