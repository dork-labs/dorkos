/**
 * Whether a paid run's turn read outside words (DOR-4204, Security Must 1),
 * for a caller that names no session: an agent token over `/mcp`, or a
 * program. Such a caller carries every mark its agent's running turns carry,
 * as memory and the browser read it. Names and paths are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../../core/turn-power/live-outsider-turns.js';
import { turnReadOutsideWords } from '../spending-port.js';

const NOW = '2026-11-16T00:00:00.000Z';

let db: Db;

beforeEach(() => {
  db = createTestDb();
  db.insert(agents)
    .values({
      id: 'agent-kestrel',
      name: 'kestrel',
      runtime: 'claude-code',
      projectPath: '/agents/kestrel',
      registeredAt: NOW,
      updatedAt: NOW,
    })
    .run();
});

afterEach(() => resetLiveOutsiderTurns());

/** Start one turn carrying `outsider` and hold it open until `end` is called. */
async function runningOutsiderTurn(): Promise<() => Promise<void>> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  async function* events(): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'reading a stranger’s page' } } as StreamEvent;
    await done;
  }
  const turn = countWhileRunning({ cwd: '/agents/kestrel' }, { outsider: true }, events());
  await turn.next();
  return async () => {
    finish();
    await turn.next();
  };
}

describe('a paid run with no session named', () => {
  it('reads clean while none of the agent’s turns is marked', () => {
    expect(turnReadOutsideWords(db)(undefined, 'agent-kestrel')).toBe(false);
  });

  it('reads as outside while one of the agent’s running turns read outside words', async () => {
    const end = await runningOutsiderTurn();
    expect(turnReadOutsideWords(db)(undefined, 'agent-kestrel')).toBe(true);
    await end();
    expect(turnReadOutsideWords(db)(undefined, 'agent-kestrel')).toBe(false);
  });

  it('reads as outside for an agent it cannot find: money fails closed', () => {
    expect(turnReadOutsideWords(db)(undefined, 'agent-nobody')).toBe(true);
  });
});
