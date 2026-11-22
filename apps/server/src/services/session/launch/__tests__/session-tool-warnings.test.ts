/** An opened Codex chat is asked about its DorkOS tools as its own agent's (DOR-5038). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, sessionNativeBindings, type Db } from '@dorkos/db';
import { setSessionAgentSources } from '../../../core/agent-identity/session-agent.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { openedChatToolWarnings } from '../session-tool-warnings.js';

const JUNO = '/agents/juno';
const at = new Date().toISOString();
let db: Db;

/** A chat launched with only a folder: no agent recorded, its folder stored. */
function bindByFolder(sessionId: string, cwd: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: 'codex', agentPath: null, createdAt: at })
    .run();
  db.insert(sessionNativeBindings)
    .values({ sessionId, runtime: 'codex', cwd, createdAt: at })
    .run();
}

beforeEach(() => {
  db = createTestDb();
  registerTestHomes([JUNO]);
  setSessionAgentSources({ db, liveCwd: () => undefined });
});

afterEach(() => {
  setSessionAgentSources(undefined);
  clearTestHomes();
});

describe('openedChatToolWarnings', () => {
  it('asks as the agent whose folder a chat with no recorded agent was started in', async () => {
    bindByFolder('by-folder', JUNO);
    const carriesRoomTools = vi.fn(async () => true);
    await openedChatToolWarnings({ type: 'codex', carriesRoomTools }, JUNO, 'by-folder');
    expect(carriesRoomTools).toHaveBeenCalledWith({
      cwd: JUNO,
      sessionId: 'by-folder',
      agentPath: JUNO,
    });
  });

  it('asks with no agent for a chat in a folder that is no agent’s', async () => {
    bindByFolder('elsewhere', '/work/project');
    const carriesRoomTools = vi.fn(async () => false);
    const result = await openedChatToolWarnings(
      { type: 'codex', carriesRoomTools },
      '/work/project',
      'elsewhere'
    );
    expect(carriesRoomTools).toHaveBeenCalledWith({
      cwd: '/work/project',
      sessionId: 'elsewhere',
    });
    expect(result.warnings?.[0]?.code).toBe('NO_DORKOS_TOOLS');
  });
});
