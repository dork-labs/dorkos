/** Which agent a chat belongs to when its launch recorded none (DOR-5035). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, sessionNativeBindings, type Db } from '@dorkos/db';
import { registerTestHomes, clearTestHomes } from './agent-home-fixture.js';
import { runtimeRegistry } from '../../runtime-registry.js';
import {
  agentOfChat,
  chatAgentStateOf,
  liveSessionCwd,
  sessionAgentById,
  sessionAgentOf,
  setSessionAgentSources,
} from '../session-agent.js';

const JUNO = '/agents/juno';
const RIO = '/agents/rio';
const at = new Date().toISOString();

let db: Db;
let live: Record<string, string>;

/** A chat bound the way launch binds one, with or without an agent. */
function bind(sessionId: string, agentPath: string | null, storedCwd?: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: 'claude-code', agentPath, createdAt: at })
    .run();
  if (storedCwd) {
    db.insert(sessionNativeBindings)
      .values({ sessionId, runtime: 'claude-code', cwd: storedCwd, createdAt: at })
      .run();
  }
}

beforeEach(() => {
  db = createTestDb();
  live = {};
  registerTestHomes([JUNO, RIO]);
  setSessionAgentSources({ liveCwd: (sessionId) => live[sessionId] });
});

afterEach(() => {
  setSessionAgentSources(undefined);
  clearTestHomes();
});

describe('sessionAgentOf', () => {
  it('keeps the recorded agent, whatever folder the chat is in', () => {
    bind('recorded', RIO, JUNO);
    expect(sessionAgentOf(db, 'recorded')).toBe(RIO);
  });

  it("names the agent whose home a chat's stored folder is", () => {
    bind('stored', null, JUNO);
    expect(sessionAgentOf(db, 'stored')).toBe(JUNO);
  });

  it('names the agent whose home its runtime is running it in, with no stored folder', () => {
    bind('running', null);
    live.running = JUNO;
    expect(sessionAgentOf(db, 'running')).toBe(JUNO);
  });

  it('prefers the stored folder to the live one', () => {
    bind('both', null, JUNO);
    live.both = RIO;
    expect(sessionAgentOf(db, 'both')).toBe(JUNO);
  });

  it('names nobody for a folder that is no agent’s, a folder inside one, or no folder', () => {
    bind('project', null, '/work/project');
    bind('inside', null, `${JUNO}/notes`);
    bind('unknown', null);
    expect(sessionAgentOf(db, 'project')).toBeUndefined();
    expect(sessionAgentOf(db, 'inside')).toBeUndefined();
    expect(sessionAgentOf(db, 'unknown')).toBeUndefined();
    expect(sessionAgentOf(db, 'no-such-chat')).toBeUndefined();
  });

  it('names nobody from its folder once no homes are known', () => {
    bind('stored', null, JUNO);
    clearTestHomes();
    expect(sessionAgentOf(db, 'stored')).toBeUndefined();
  });
});

describe('chatAgentStateOf', () => {
  it('tells an agent, an unknown agent, nobody’s folder and a refused folder apart', () => {
    registerTestHomes([JUNO, RIO], { managed: { '/workspaces/ghost': '/agents/gone' } });
    bind('agent', null, JUNO);
    bind('unknown', null);
    bind('nobody', null, '/work/project');
    bind('refused', null, '/workspaces/ghost');
    expect(chatAgentStateOf(db, 'agent')).toEqual({ kind: 'agent', agentPath: JUNO });
    expect(chatAgentStateOf(db, 'unknown')).toEqual({ kind: 'unknown' });
    expect(chatAgentStateOf(db, 'no-such-chat')).toEqual({ kind: 'unknown' });
    expect(chatAgentStateOf(db, 'nobody')).toEqual({ kind: 'nobody' });
    expect(chatAgentStateOf(db, 'refused')).toEqual({ kind: 'refused' });
  });

  it('reads the live folder when the stored one is empty', () => {
    bind('empty', null);
    db.insert(sessionNativeBindings)
      .values({ sessionId: 'empty', runtime: 'claude-code', cwd: '', createdAt: at })
      .run();
    live.empty = JUNO;
    expect(chatAgentStateOf(db, 'empty')).toEqual({ kind: 'agent', agentPath: JUNO });
  });
});

describe('sessionAgentById', () => {
  it('resolves from the database wired at boot; before that, reads only the recorded agent', async () => {
    runtimeRegistry.setDb(db);
    bind('stored', null, JUNO);
    bind('recorded', RIO);
    setSessionAgentSources(undefined);
    await expect(sessionAgentById('stored')).resolves.toBeUndefined();
    await expect(sessionAgentById('recorded')).resolves.toBe(RIO);
    setSessionAgentSources({ db, liveCwd: (sessionId) => live[sessionId] });
    await expect(sessionAgentById('stored')).resolves.toBe(JUNO);
    await expect(sessionAgentById('recorded')).resolves.toBe(RIO);
  });
});

describe('agentOfChat and liveSessionCwd', () => {
  it('reads the recorded agent first, then the folder', () => {
    expect(agentOfChat(RIO, JUNO)).toBe(RIO);
    expect(agentOfChat(null, JUNO)).toBe(JUNO);
    expect(agentOfChat(null, undefined)).toBeUndefined();
  });

  it('answers nothing live when unwired', () => {
    live.running = JUNO;
    expect(liveSessionCwd('running')).toBe(JUNO);
    setSessionAgentSources(undefined);
    expect(liveSessionCwd('running')).toBeUndefined();
  });
});
