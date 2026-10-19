/**
 * Security's deferred-raise case (DOR-3106/3107, Security 19:03): a sender whose level is
 * unknown but whom a stranger reached opens a chat; the raise is put off one start (the
 * person-set record is not readable yet); on the next start the chat still stays capped,
 * because the row the sender wrote keeps the mark. A sender of unknown level nobody
 * outside reached opens a chat that does rise, so the test cannot pass by raising nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { resolveStopMode, type DeclaredModes } from '@dorkos/shared/permission-semantics';

import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { senderCeilingJson } from '../../../session/chat-messages/chat-message-ceiling.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { chatLaunchMarks } from '../chat-launch-marks.js';
import {
  raiseExistingChats,
  setChatModePort,
  type ChatModePort,
  type ExistingChatsRaiseDeps,
} from '../existing-chats-raise.js';
import { createPermissionWorld } from './permission-fixtures.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes as DeclaredModes;
const FULL = resolveStopMode('autonomy', MODES.values)!;
const NOW = '2026-10-19T12:00:00.000Z';
const AGENT = { id: 'a-build', name: 'builder', projectPath: '/agents/builder' };

let db: Db;
let dir: string;
beforeEach(() => {
  db = createTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-deferred-'));
  resetOutsiderTurns();
});
afterEach(() => {
  setChatModePort(null);
  resetOutsiderTurns();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A chat row of the builder agent. */
function chat(id: string, origin: string, mode: string | null) {
  db.run(sql`INSERT INTO session_metadata (session_id, runtime, agent_path, launch_origin,
    permission_mode, created_at)
    VALUES (${id}, 'claude-code', ${AGENT.projectPath}, ${origin}, ${mode}, ${NOW})`);
}

/** The message that opened `to`, stored exactly as chat_send stores it. */
async function openedBy(to: string, from: string) {
  const ceilingJson = await senderCeilingJson(
    { turnLevelOf: () => undefined },
    { sessionId: from, agentPath: AGENT.projectPath }
  );
  db.run(sql`INSERT INTO chat_messages (id, to_session_id, from_session_id, from_agent_path,
    from_agent_name, kind, text, delivery, status, ceiling_json, created_at, updated_at)
    VALUES (${`m-${to}`}, ${to}, ${from}, ${AGENT.projectPath}, 'builder', 'message', 'hi',
      'queue', 'delivered', ${ceilingJson}, ${NOW}, ${NOW})`);
  return ceilingJson;
}

/** One start's raise over the database, with the person-set record seeded or not. */
function boot(seeded: boolean, world: ReturnType<typeof createPermissionWorld>) {
  const port: ChatModePort = {
    modeOf: (id) => {
      const row = db.get<{ m: string | null }>(
        sql`SELECT permission_mode AS m FROM session_metadata WHERE session_id = ${id}`
      );
      return row ? row.m : 'gone';
    },
    setMode: async (id, mode) => {
      db.run(sql`UPDATE session_metadata SET permission_mode = ${mode ?? MODES.default!}
        WHERE session_id = ${id}`);
    },
    isLooser: async () => false,
  };
  setChatModePort(port);
  const launchMarked = chatLaunchMarks(db, true);
  const deps: ExistingChatsRaiseDeps = {
    doneFile: path.join(dir, 'permissions', 'existing-chats-raised.json'),
    chats: () =>
      db.all(sql`SELECT session_id AS sessionId, runtime, agent_path AS agentPath,
        launch_origin AS launchOrigin, permission_mode AS permissionMode
        FROM session_metadata`),
    agents: () => [AGENT],
    launchMarked: (row) => launchMarked(row.sessionId, row.launchOrigin),
    personSet: { isSeeded: () => seeded, get: () => undefined },
    defaultStop: () => 'autonomy',
    agentStop: async () => undefined,
    modes: () => MODES,
    port,
    activity: world.activity,
    priorRaise: async () => false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return raiseExistingChats(deps);
}

describe('a chat a stranger-reached sender of unknown level opened, across a deferred raise', () => {
  it('stays capped on the start the raise finally runs, while an unreached one rises', async () => {
    // Two senders of ours, neither with a level this process knows. A stranger reached one.
    chat('reached-sender', 'interactive', FULL);
    chat('quiet-sender', 'interactive', FULL);
    noteTurnOrigin('reached-sender', { kind: 'outside-sender' });

    chat('opened-by-reached', 'chat-message', 'default');
    chat('opened-by-quiet', 'chat-message', 'default');
    expect(JSON.parse(await openedBy('opened-by-reached', 'reached-sender'))).toEqual({
      bound: 'runtime-default',
      marks: { outsider: true },
    });
    expect(JSON.parse(await openedBy('opened-by-quiet', 'quiet-sender'))).not.toHaveProperty(
      'marks'
    );

    // The process restarts: nothing it knew in memory survives.
    resetOutsiderTurns();
    const world = createPermissionWorld({ agents: [AGENT] });

    // First start: the person-set record is not readable yet, so the raise waits.
    expect(await boot(false, world)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'permissions', 'existing-chats-raised.json'))).toBe(false);

    // Next start: the raise runs, and reads the mark the row kept.
    expect(await boot(true, world)).toEqual({ raised: 1 });
    const mode = (id: string) =>
      db.get<{ m: string }>(
        sql`SELECT permission_mode AS m FROM session_metadata WHERE session_id = ${id}`
      )?.m;
    expect(mode('opened-by-reached')).toBe('default');
    expect(mode('opened-by-quiet')).toBe(FULL);
  });
});
