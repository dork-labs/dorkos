/**
 * A promise made in a marked turn keeps the turn's marks (DOR-3036, `specs/turn-marks`): the beat
 * its due date wakes reads the promise, so it carries the marks on rather than reading a
 * stranger's or a teammate's words as the agent's own. In a chat set to Full
 * autonomy an outsider's mark refuses nothing (DOR-3412); a teammate's still does.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { CommitmentStore } from '../commitment-store.js';
import { CommitmentService } from '../commitment-service.js';
import { commitmentsDomain } from '../commitment-capabilities.js';
import { composeRegistry } from '../../core/capabilities/index.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import {
  noteChosenTurn,
  resetChosenTurns,
  setMarkedFullActivity,
} from '../../core/turn-power/full-autonomy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const PRIYA = { roomId: 'space-room', authorId: 'priya' };

/** Record that a turn ran on `sessionId` with this ceiling, as the registry's wrapper does. */
async function ran(sessionId: string, permissionCeiling?: unknown): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  const opts = permissionCeiling === undefined ? undefined : { permissionCeiling };
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts as never)) {
    // drain
  }
}

let service: CommitmentService;

beforeEach(() => {
  resetLiveOutsiderTurns();
  service = new CommitmentService({ store: new CommitmentStore(createTestDb()) });
});

afterEach(() => {
  resetLiveOutsiderTurns();
  resetChosenTurns();
  setMarkedFullActivity(undefined);
});

const FULL = { asks: 'never', reach: 'everything' } as const;
const ASK_FIRST = { asks: 'always', reach: 'everything' } as const;

function add(sessionId: string, what: string) {
  const registry = composeRegistry([commitmentsDomain], {
    logger: noopLogger,
    commitmentDeps: { service, agentIdForPath: () => 'agent-bo' } as never,
  });
  return registry.invoke(
    'commitments.add',
    { what },
    {
      sessionId,
      identity: { agentPath: '/agents/bo', displayName: 'Bo', createdAt: '2026-10-10T00:00:00Z' },
    }
  );
}

describe('a promise made in a marked turn', () => {
  it('is refused, so no marked promise reaches the agent’s beat (DOR-3037)', async () => {
    await ran('owner-turn');
    await ran('teammate-hop', ['runtime-default', { ...READ_ONLY_LEVEL, teammate: [PRIYA] }]);

    await add('owner-turn', 'Send the owner the report');
    expect(service.openMarks('agent-bo')).toEqual({});

    expect(await add('teammate-hop', 'Send Priya the numbers')).toMatchObject({
      ok: false,
      code: 'OUTSIDER_TURN',
    });
    expect(service.openMarks('agent-bo')).toEqual({});
  });

  it('keeps the marks a promise was recorded with, and an agent’s open promises carry them to its beat', () => {
    service.create('agent-bo', { what: 'Send the owner the report' });
    service.create('agent-bo', {
      what: 'Send Priya the numbers',
      originMarks: { outsider: true, teammate: [PRIYA] },
    });
    expect(service.openMarks('agent-bo')).toEqual({ outsider: true, teammate: [PRIYA] });
  });

  it('stops marking the beat once the marked promise is closed', () => {
    const made = service.create('agent-bo', {
      what: 'Quote the stranger a price',
      originMarks: { outsider: true },
    });
    expect(service.openMarks('agent-bo')).toEqual({ outsider: true });
    service.update({ kind: 'agent', agentId: 'agent-bo' } as never, made.id, {
      state: 'dropped',
    });
    expect(service.openMarks('agent-bo')).toEqual({});
  });

  it('is made in a chat set to Full, carrying the marks, with one Activity line (DOR-3412)', async () => {
    const emit = vi.fn(async () => undefined);
    setMarkedFullActivity({ emit } as never);
    await ran('full-stranger-turn', 'runtime-default');
    noteChosenTurn('full-stranger-turn', FULL as never, false);
    expect(await add('full-stranger-turn', 'Send the report')).toMatchObject({ ok: true });
    expect(service.openMarks('agent-bo')).toEqual({ outsider: true });
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      eventType: 'agent.marked_full_action',
      resourceId: 'commitments.add',
      actorId: '/agents/bo',
    });
  });

  it('is still refused below Full, and a teammate’s mark is refused even at Full', async () => {
    const emit = vi.fn(async () => undefined);
    setMarkedFullActivity({ emit } as never);
    await ran('ask-stranger-turn', 'runtime-default');
    noteChosenTurn('ask-stranger-turn', ASK_FIRST as never, false);
    expect(await add('ask-stranger-turn', 'Send the report')).toMatchObject({
      code: 'OUTSIDER_TURN',
    });
    await ran('full-teammate-hop', ['runtime-default', { ...READ_ONLY_LEVEL, teammate: [PRIYA] }]);
    noteChosenTurn('full-teammate-hop', FULL as never, false);
    expect(await add('full-teammate-hop', 'Send Priya the numbers')).toMatchObject({
      code: 'OUTSIDER_TURN',
    });
    expect(service.openMarks('agent-bo')).toEqual({});
    expect(emit).not.toHaveBeenCalled();
  });
});
