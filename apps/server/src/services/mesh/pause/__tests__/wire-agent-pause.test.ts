/**
 * The pause service as startup builds it (spec `audit-trail` PR5): registered
 * process-wide, and stopping the agent's task runs through the scheduler once
 * the scheduler exists, and nothing before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import { agentPause, resetAgentPause } from '../agent-pause.js';
import { wireAgentPause } from '../wire-agent-pause.js';

const SCOUT_ID = '01SCOUTAGENTULID0000000000';
const PERSON: AuditActor = { accountId: 'install:inst-1', kind: 'person', name: 'Owner' };

function seededDb(): Db {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: SCOUT_ID,
      name: 'scout',
      runtime: 'claude-code',
      projectPath: '/projects/scout',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

describe('wireAgentPause', () => {
  afterEach(() => resetAgentPause());

  it('registers the service, and stops no runs before the scheduler exists', async () => {
    const pauses = wireAgentPause(seededDb(), () => null);
    expect(agentPause()).toBe(pauses);
    await expect(pauses.pause(SCOUT_ID, PERSON)).resolves.toMatchObject({
      paused: true,
      stoppedRuns: 0,
    });
  });

  it("stops the agent's runs through the scheduler once it exists", async () => {
    const cancelRunsForAgent = vi.fn().mockResolvedValue(2);
    let scheduler: { cancelRunsForAgent: typeof cancelRunsForAgent } | null = null;
    const pauses = wireAgentPause(seededDb(), () => scheduler);
    scheduler = { cancelRunsForAgent };
    await expect(pauses.pause(SCOUT_ID, PERSON)).resolves.toMatchObject({ stoppedRuns: 2 });
    expect(cancelRunsForAgent).toHaveBeenCalledWith(SCOUT_ID);
  });
});
