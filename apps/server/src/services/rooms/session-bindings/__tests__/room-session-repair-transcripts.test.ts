/**
 * The repair sweep, against transcripts that are really on disk (DOR-784).
 *
 * `room-session-convergence.test.ts` injects the transcript probe, which is the
 * right seam for the sweep's LOGIC. It cannot catch the class of bug that makes
 * the whole feature inert, though: asking the reader the wrong question. The
 * probe takes a working directory and a session id, in that order, and resolves
 * the SDK's project slug from the directory — swap the arguments, or hand it the
 * session's id where its cwd belongs, and every binding on the machine reports
 * "no transcript" while every test with a fake probe stays green.
 *
 * So this file stages a real Claude account directory, writes real JSONL under
 * the real slug, and wires the real {@link TranscriptReader} exactly as
 * `index.ts` does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSessions } from '@dorkos/db';

// Hoisted holder so the config-dir resolvers can be pointed at a per-test root.
const hoisted = vi.hoisted(() => ({ configDir: '' }));
vi.mock('../../../runtimes/claude-code/claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => hoisted.configDir,
  resolveClaudeRootSet: () => [hoisted.configDir],
}));

import { RoomStore } from '../../room-store.js';
import { repairRoomSessionBindings } from '../room-session-convergence.js';
import { TranscriptReader } from '../../../runtimes/claude-code/sessions/transcript-reader.js';
import { projectSlug } from '../../../runtimes/claude-code/sessions/project-slug.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { logger } from '../../../../lib/logger.js';

const PLACEHOLDER = '00dfdce7-1111-4222-8333-444444444444';
const CANONICAL = '0e7270c6-5555-4666-8777-888888888888';
const ROOM = 'room-backend';
const ANA = 'author-ana';

describe('the repair sweep over real transcripts on disk', () => {
  let claudeRoot: string;
  let agentPath: string;
  let db: ReturnType<typeof createTestDb>;
  let store: RoomStore;
  let reader: TranscriptReader;

  beforeEach(async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), 'dorkos-room-repair-claude-'));
    hoisted.configDir = claudeRoot;
    agentPath = await mkdtemp(join(tmpdir(), 'dorkos-room-repair-agent-'));
    // The slug is derived the way the SDK derives it, from the agent's own
    // working directory — realpath, NFC and truncation included.
    await mkdir(join(claudeRoot, 'projects', projectSlug(agentPath)), { recursive: true });
    db = createTestDb();
    // The shared binding probe asks the registry which runtime owns a session
    // before it probes for a transcript (DOR-805); that read needs a database.
    runtimeRegistry.setDb(db);
    store = new RoomStore(db);
    store.bindRoomSession(ROOM, ANA, PLACEHOLDER, new Date().toISOString());
    reader = new TranscriptReader();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(claudeRoot, { recursive: true, force: true });
    await rm(agentPath, { recursive: true, force: true });
  });

  /** Stage a transcript for `sessionId` under the agent's slug directory. */
  async function writeTranscript(sessionId: string): Promise<void> {
    await writeFile(
      join(claudeRoot, 'projects', projectSlug(agentPath), `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'is the build green?' },
        timestamp: '2026-07-31T09:00:00.000Z',
        cwd: agentPath,
      }) + '\n'
    );
  }

  /** The sweep wired the way the composition root wires it. */
  function sweep(): ReturnType<typeof repairRoomSessionBindings> {
    return repairRoomSessionBindings({
      store,
      agentPathFor: (authorId) => (authorId === ANA ? agentPath : null),
      hasTranscript: async (cwd, sessionId) => (await reader.hasTranscript(cwd, sessionId)).exists,
    });
  }

  /** What `room_sessions` says Ana answers with in this room. */
  function bound(): string | null {
    return (
      db.select().from(roomSessions).where(eq(roomSessions.roomId, ROOM)).get()?.sessionId ?? null
    );
  }

  it('repairs a binding whose id has no JSONL, onto the id that does', async () => {
    // The exact incident shape: the placeholder never got a file, because Claude
    // Code named the session CANONICAL and wrote the transcript under that.
    await writeTranscript(CANONICAL);
    store.sessionLedger.retire(PLACEHOLDER, CANONICAL);

    const report = await sweep();

    expect(bound()).toBe(CANONICAL);
    expect(report).toEqual({
      checked: 1,
      repaired: 1,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
  });

  it('leaves a stranded binding alone, and says which room and id it is', async () => {
    // Nothing on disk under either id, and no rename this process watched.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await sweep();

    expect(bound()).toBe(PLACEHOLDER);
    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 1,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no transcript'),
      expect.objectContaining({ roomId: ROOM, agentPath, deadSessionId: PLACEHOLDER })
    );
  });

  it('says nothing about a healthy binding whose transcript is right there', async () => {
    await writeTranscript(PLACEHOLDER);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const report = await sweep();

    expect(bound()).toBe(PLACEHOLDER);
    expect(report).toEqual({
      checked: 1,
      repaired: 0,
      stranded: 0,
      refused: 0,
      failed: 0,
      unreadable: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
