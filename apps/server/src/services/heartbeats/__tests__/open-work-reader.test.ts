/**
 * Which lanes are an agent's open work (DOR-3674): chats a `session_start` from one of its own
 * chats opened, over the last three days, read from `session_started_by` on a real database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionStartedBy, type Db } from '@dorkos/db';
import { createOpenWorkReader, LANE_OPEN_MS } from '../gatherers/open-work-reader.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const JUNO = { id: 'agent-juno', name: 'Juno', projectPath: '/agents/juno', cwd: null };

/** One `session_started_by` row. */
function started(db: Db, sessionId: string, parent: string | null, ageMs: number, kind = 'chat') {
  db.insert(sessionStartedBy)
    .values({
      sessionId,
      kind: kind as 'chat' | 'extension',
      startedBySessionId: parent,
      reason: `lane ${sessionId}`,
      createdAt: new Date(NOW - ageMs).toISOString(),
    })
    .run();
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('the lanes an agent started', () => {
  it('are the recent chats its own chats started, and no one else’s', async () => {
    const db = createTestDb();
    const owners: Record<string, string> = {
      'juno-chat': '/agents/juno',
      'otto-chat': '/agents/otto',
    };
    started(db, 'mine', 'juno-chat', 60 * 60 * 1000);
    started(db, 'theirs', 'otto-chat', 60 * 60 * 1000);
    started(db, 'too-old', 'juno-chat', LANE_OPEN_MS + 60 * 1000);
    started(db, 'no-parent', null, 60 * 60 * 1000);
    started(db, 'an-extension', 'juno-chat', 60 * 60 * 1000, 'extension');
    const built = createOpenWorkReader(db, {
      agentIdForCwd: () => undefined,
      agentPathOf: async (id) => owners[id] ?? null,
      now: () => NOW,
    });
    stop = built.stop;

    const lanes = await built.reader.lanesOf(JUNO, new Date(NOW));
    expect(lanes).toEqual([
      {
        sessionId: 'mine',
        startedAt: new Date(NOW - 3_600_000).toISOString(),
      },
    ]);
  });

  it('reads a starting chat whose agent cannot be read as nobody’s', async () => {
    const db = createTestDb();
    started(db, 'mine', 'juno-chat', 60 * 60 * 1000);
    const built = createOpenWorkReader(db, {
      agentIdForCwd: () => undefined,
      agentPathOf: async () => {
        throw new Error('unreadable');
      },
      now: () => NOW,
    });
    stop = built.stop;
    expect(await built.reader.lanesOf(JUNO, new Date(NOW))).toEqual([]);
  });
});

// Security on DOR-3674: open-work reads `session_started_by`, the to-dos store and chat
// status, and starts or messages nothing; the beat decides. Pinned by what the two files import,
// so a later edit that reaches for a launcher or a sender fails here.
describe('open work only reads', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const SOURCES = ['../gatherers/open-work.ts', '../gatherers/open-work-reader.ts'];
  const SENDS =
    /launch|dispatch|chat-message|relay|beat-launch|post-to-room|room-service|notify|outbox|\.insert\(|\.update\(|\.delete\(/;

  it.each(SOURCES)('%s imports and calls nothing that starts, sends or writes', (file) => {
    const source = readFileSync(path.join(here, file), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
    expect(imports.filter((spec) => SENDS.test(spec))).toEqual([]);
    expect(source).not.toMatch(/\bdb\s*\.\s*(insert|update|delete)\b/);
  });
});
