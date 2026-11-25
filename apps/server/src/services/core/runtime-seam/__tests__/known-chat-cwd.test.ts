/**
 * Where a chat runs, for a notice written after the emitter's own naming was
 * lost: the runtime's answer, else the projector's folder (Codex and OpenCode
 * have no runtime answer), else the session record's agent folder. Real
 * SQLite and a real projector.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionMetadata, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { knownChatCwd } from '../live-runtime-cwd.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  disposeProjector('chat-projected');
});

describe('knownChatCwd', () => {
  it('falls back from the runtime to the projector, then to the session record', () => {
    getOrCreateProjector('chat-projected').cwd = '/Users/dev/acme';
    db.insert(sessionMetadata)
      .values({
        sessionId: 'chat-recorded',
        runtime: 'codex',
        agentPath: '/Users/dev/beta',
        createdAt: new Date().toISOString(),
      })
      .run();

    expect(knownChatCwd(db, 'chat-projected')).toBe('/Users/dev/acme');
    expect(knownChatCwd(db, 'chat-recorded')).toBe('/Users/dev/beta');
    expect(knownChatCwd(db, 'chat-unknown')).toBeUndefined();
  });
});
