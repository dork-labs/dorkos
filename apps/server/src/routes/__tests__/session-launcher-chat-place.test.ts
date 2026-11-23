/**
 * Who may change a message waiting in a chat whose launch recorded no agent (DOR-5035): the
 * chat's agent is the one whose home its folder is, and a chat with no folder known names nobody.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import type { RequestFacts } from '../../http/request-facts.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../services/core/agent-identity/__tests__/agent-home-fixture.js';
import { setSessionAgentSources } from '../../services/core/agent-identity/session-agent.js';
import { chatPlaceRefusal } from '../session-launcher.js';

const JUNO = '/agents/juno';
const RIO = '/agents/rio';
const mesh = {
  listWithPaths: () => [
    { id: 'juno', name: 'juno', projectPath: JUNO },
    { id: 'rio', name: 'rio', projectPath: RIO },
  ],
};

let db: Db;
let live: Record<string, string>;

/** A request from an agent whose token verified. */
function asAgent(agentPath: string): RequestFacts {
  return { headers: {}, agentIdentity: { agentPath } } as unknown as RequestFacts;
}

/** A chat bound the way a folder-only launch binds one: no agent recorded. */
function unrecordedChat(sessionId: string, runningIn?: string): void {
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: 'claude-code',
      agentPath: null,
      createdAt: new Date().toISOString(),
    })
    .run();
  if (runningIn) live[sessionId] = runningIn;
}

beforeEach(() => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  live = {};
  registerTestHomes([JUNO, RIO]);
  setSessionAgentSources({ liveCwd: (sessionId) => live[sessionId] });
});

afterEach(() => {
  setSessionAgentSources(undefined);
  clearTestHomes();
});

describe('a waiting message in a chat that recorded no agent', () => {
  it("refuses another agent, since the chat is its folder's agent's", async () => {
    unrecordedChat('juno-chat', JUNO);
    await expect(chatPlaceRefusal(asAgent(RIO), mesh as never, 'juno-chat')).resolves.toMatchObject(
      { code: 'OTHER_AGENTS_CHAT' }
    );
  });

  it('lets the chat’s own agent through', async () => {
    unrecordedChat('juno-chat', JUNO);
    await expect(chatPlaceRefusal(asAgent(JUNO), mesh as never, 'juno-chat')).resolves.toBeNull();
  });

  it('refuses an agent when no folder for the chat is known', async () => {
    unrecordedChat('lost-chat');
    await expect(
      chatPlaceRefusal(asAgent(JUNO), mesh as never, 'lost-chat')
    ).resolves.toMatchObject({ code: 'OTHER_AGENTS_CHAT' });
  });

  it('still lets an agent into a chat about a folder that is no agent’s', async () => {
    unrecordedChat('project-chat', '/work/project');
    await expect(chatPlaceRefusal(asAgent(RIO), mesh as never, 'project-chat')).resolves.toBeNull();
  });

  it('refuses an agent when the folder belongs to an agent that is no longer registered', async () => {
    registerTestHomes([JUNO, RIO], { managed: { '/workspaces/gone-ws': '/agents/gone' } });
    unrecordedChat('orphan-chat', '/workspaces/gone-ws');
    await expect(
      chatPlaceRefusal(asAgent(RIO), mesh as never, 'orphan-chat')
    ).resolves.toMatchObject({ code: 'OTHER_AGENTS_CHAT' });
  });
});
