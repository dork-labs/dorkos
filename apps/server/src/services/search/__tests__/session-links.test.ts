/**
 * Every runtime's hits open the DorkOS session they came from (DOR-2020,
 * message-search spec Amendment 14).
 *
 * **Written as one table over the three runtimes rather than three test
 * bodies**, because the bug was not a broken lookup — it was a rule that had
 * only ever been checked on the one runtime where the two ids happen to be the
 * same string. A per-runtime test file would have been green on Claude Code and
 * absent for the other two, which is exactly the state this replaced. A fourth
 * runtime joins the array and inherits both halves of the contract.
 *
 * Both halves are asserted over the SAME seeded rows: the hit is really there
 * and really matches, and what changes between the bound and unbound cases is
 * only whether it can be opened. `expect(sessionId).toBeUndefined()` on its own
 * passes for a working resolver, for an empty index and for a query that
 * matched nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { codexThreads, messages, opencodeSessions, searchSources, type Db } from '@dorkos/db';
import { searchForCaller, type SearchScope } from '../search-service.js';
import { resolveSessionIds } from '../session-links.js';

let db: Db;

const AT = '2026-09-13T09:00:00.000Z';

/** The owner: every room, and session history in reach. */
const OWNER: SearchScope = { rooms: 'all', sessions: true };

/**
 * One indexed message, written the way a sweep writes it: under the container
 * id the store that owns the transcript uses, never under a DorkOS id.
 *
 * @param sourceId - Which source indexed it.
 * @param originKey - The runtime's own container id.
 * @param body - What was said.
 */
function transcribe(sourceId: string, originKey: string, body: string): void {
  db.insert(messages)
    .values({ sourceId, originKey, ordinal: 1, role: 'user', createdAt: AT, body })
    .run();
  db.insert(searchSources)
    .values({
      sourceId,
      originKey,
      lastOrdinal: 1,
      containerPath: '/Users/dork/code/dorkos',
      lastIndexedAt: AT,
    })
    .run();
}

/** Search as the owner, with the defaults the route uses. */
function search(query: string) {
  return searchForCaller(db, OWNER, { query, limit: 20 }).results;
}

/**
 * One runtime, and how DorkOS knows which of its conversations is which.
 *
 * `bind` is what the runtime does when DorkOS starts a session on it. Claude
 * Code's is empty and that is the whole of its row: DorkOS reads the SDK's own
 * transcript store, so the id the index holds is already the id the session
 * route resolves and there is nothing to map.
 */
const RUNTIMES = [
  {
    source: 'claude-code',
    /** The container id the index holds — the SDK's own session id. */
    native: 'aa11bb22-cc33-4d44-8e55-ff6600771122',
    /** What `/session` opens it by. */
    dorkos: 'aa11bb22-cc33-4d44-8e55-ff6600771122',
    /**
     * Whether a transcript with no DorkOS binding can still be opened.
     *
     * True only for Claude Code, and not as a special case: its transcript
     * store IS the store the session view reads, so a conversation held with the
     * bare `claude` command is a session DorkOS can open even though DorkOS
     * never ran it. The other two runtimes keep their conversations in their own
     * stores and DorkOS reaches one only through a binding it wrote itself.
     */
    opensWithoutBinding: true,
    bind: () => {},
  },
  {
    source: 'codex',
    native: '019fe200-e5e8-7d23-9e68-3a32dd78cf8a',
    dorkos: 'd1000000-0000-4000-8000-000000000001',
    opensWithoutBinding: false,
    bind: () => {
      db.insert(codexThreads)
        .values({
          sessionId: 'd1000000-0000-4000-8000-000000000001',
          threadId: '019fe200-e5e8-7d23-9e68-3a32dd78cf8a',
          cwd: '/Users/dork/code/dorkos',
          createdAt: AT,
        })
        .run();
    },
  },
  {
    source: 'opencode',
    native: 'ses_7f3c1d2e9',
    dorkos: 'd2000000-0000-4000-8000-000000000002',
    opensWithoutBinding: false,
    bind: () => {
      db.insert(opencodeSessions)
        .values({
          sessionId: 'd2000000-0000-4000-8000-000000000002',
          ocSessionId: 'ses_7f3c1d2e9',
          createdAt: AT,
        })
        .run();
    },
  },
] as const;

beforeEach(() => {
  db = createTestDb();
});

describe('a hit opens the DorkOS session it came from', () => {
  for (const runtime of RUNTIMES) {
    it(`carries the DorkOS session id for a ${runtime.source} session DorkOS ran`, () => {
      transcribe(runtime.source, runtime.native, 'the kestrel we saw on the walk');
      runtime.bind();

      const [hit] = search('kestrel');

      expect(hit).toBeDefined();
      expect(hit?.sessionId).toBe(runtime.dorkos);
      // The container is unchanged and still the runtime's own id. It is the
      // index's coordinate and the key `messageId` lands through; the fix adds
      // a field rather than redefining an opaque one.
      expect(hit?.container).toBe(runtime.native);
    });

    it(`still returns a ${runtime.source} hit DorkOS never ran, ${
      runtime.opensWithoutBinding ? 'and can open it' : 'marked as opening nothing'
    }`, () => {
      // No `bind()`: this is a conversation somebody had with the runtime's own
      // command-line tool. It is indexed and searchable either way.
      transcribe(runtime.source, runtime.native, 'the kestrel we saw on the walk');

      const [hit] = search('kestrel');

      expect(hit).toBeDefined();
      expect(hit?.container).toBe(runtime.native);
      expect(hit?.sessionId).toBe(runtime.opensWithoutBinding ? runtime.dorkos : undefined);
    });
  }

  it('sends no session for a hit whose binding names a different conversation', () => {
    // The positive control for the two lookups: a resolver that answered with
    // whatever single row the table held would pass every case above.
    transcribe('opencode', 'ses_7f3c1d2e9', 'the kestrel we saw on the walk');
    db.insert(opencodeSessions)
      .values({
        sessionId: 'd3000000-0000-4000-8000-000000000003',
        ocSessionId: 'ses_somebody_else',
        createdAt: AT,
      })
      .run();

    expect(search('kestrel')[0]?.sessionId).toBeUndefined();
  });

  it('resolves each hit to its own session when several runtimes match at once', () => {
    // The whole point of the feature is one ranked list across sources, so the
    // per-hit lookup has to survive being handed a mixed batch — a bug that
    // keyed by container alone would cross the two.
    for (const runtime of RUNTIMES) {
      transcribe(runtime.source, runtime.native, 'the kestrel we saw on the walk');
      runtime.bind();
    }

    const bySource = new Map(search('kestrel').map((hit) => [hit.source, hit.sessionId]));

    expect(bySource.size).toBe(RUNTIMES.length);
    for (const runtime of RUNTIMES) {
      expect(bySource.get(runtime.source)).toBe(runtime.dorkos);
    }
  });

  it('sends no session for a room hit', () => {
    // A room is not a session, and a room hit already lands by `seq`. Absent is
    // the honest answer rather than a room id squeezed into a session field.
    transcribe('rooms', 'room-1', 'the kestrel we saw on the walk');

    const [hit] = search('kestrel');

    expect(hit?.container).toBe('room-1');
    expect(hit?.sessionId).toBeUndefined();
  });

  it('sends no session for a source it has never heard of', () => {
    // Fail closed. Guessing that some future source's container doubles as a
    // session id is how this bug happened on the two runtimes that shipped
    // after Claude Code. Asked of the resolver directly, because an unregistered
    // source is not in anybody's scope and so never reaches a hit — which would
    // make this pass for the wrong reason through `searchForCaller`.
    const resolved = resolveSessionIds(db, [
      { sourceId: 'some-future-source', originKey: 'whatever-it-composes' },
    ]);

    expect(resolved.size).toBe(0);
  });
});
