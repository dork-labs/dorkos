/**
 * The production wiring of the level-reach line (DOR-3175), over a real db and
 * the real runtime registry: a direct chat stored with `agent_path = NULL` is
 * found by the folder its runtime holds it in, the way its turn is — QA's
 * #3142 miss, where the count saw only chats with a recorded agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata } from '@dorkos/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../../services/runtimes/claude-code/runtime-constants.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../services/core/agent-identity/__tests__/agent-home-fixture.js';

const ANA = '/agents/ana';

vi.mock('../../../services/core/capabilities/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  permissionGateSources: () => ({
    readAgentPermissions: async (agentPath: string) =>
      agentPath === ANA ? { filesAndCommands: 'ask' } : undefined,
  }),
}));

const { runtimeRegistry } = await import('../../../services/core/runtime-registry.js');
const { levelReachFor } = await import('../level-reach.js');

describe('the level-reach wiring (DOR-3175)', () => {
  beforeEach(() => {
    registerTestHomes([ANA]);
  });
  afterEach(() => clearTestHomes());

  it('counts a direct chat with no recorded agent, by the folder its runtime holds', async () => {
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    const cwds: Record<string, string> = { g: `${ANA}/sub/deep` };
    runtimeRegistry.register({
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      getSessionCwd: (id: string) => cwds[id],
    } as unknown as AgentRuntime);
    db.insert(sessionMetadata)
      .values({
        sessionId: 'g',
        runtime: 'claude-code',
        agentPath: null,
        launchOrigin: 'interactive',
        permissionMode: 'bypassPermissions',
        createdAt: new Date().toISOString(),
      })
      .run();
    const reach = levelReachFor(db, { getDot: () => 'autonomy' });
    const result = await reach([
      {
        target: { kind: 'agent', agentId: 'ana', agentPath: ANA, agentName: 'Ana' },
        key: { kind: 'files' },
        before: null,
        after: 'ask',
      },
    ]);
    expect(result?.line).toBe('1 chat follows it');
  });
});
