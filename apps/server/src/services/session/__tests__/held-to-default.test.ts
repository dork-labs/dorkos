/**
 * Messages held to the runtime's default (DOR-3037): which ceilings hold, when
 * a held steer may join a running turn, how a launching row's hold is added to
 * its ceiling, and that a queue row keeps its hold through an edit.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import {
  ceilingHoldsToDefault,
  heldMessageMayJoin,
} from '../message-dispatcher/held-to-default.js';
import { launchCeiling } from '../message-dispatcher/state.js';
import { MessageQueueStore } from '../message-queue-store.js';

const runtime = {
  type: 'claude-code',
  getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
  async *sendMessage(): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  },
} as unknown as AgentRuntime;

/** Record a turn on `sessionId` at `mode` under `opts`. */
async function ranAt(sessionId: string, mode: string, opts?: MessageOpts) {
  const seam = recordTurnLevels(runtime, () => mode);
  for await (const _event of seam.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('ceilingHoldsToDefault', () => {
  it('reads the runtime default alone or in a list', () => {
    expect(ceilingHoldsToDefault('runtime-default')).toBe(true);
    expect(ceilingHoldsToDefault([{ asks: 'always', reach: 'edit' }, 'runtime-default'])).toBe(
      true
    );
    expect(ceilingHoldsToDefault({ asks: 'always', reach: 'edit' })).toBe(false);
    expect(ceilingHoldsToDefault(undefined)).toBe(false);
  });
});

describe('heldMessageMayJoin', () => {
  it('lets a held steer join a turn already held to the default', async () => {
    await ranAt('held-turn', 'bypassPermissions', { permissionCeiling: 'runtime-default' });
    expect(heldMessageMayJoin(runtime, 'held-turn', 'steer')).toBe(true);
  });

  it('keeps it out of a turn at the agent’s own level, or one never recorded', async () => {
    await ranAt('full-turn', 'bypassPermissions');
    expect(heldMessageMayJoin(runtime, 'full-turn', 'steer')).toBe(false);
    expect(heldMessageMayJoin(runtime, 'never-ran', 'steer')).toBe(false);
  });

  it('never lets a held stage join, since it rides whichever turn runs next', async () => {
    await ranAt('held-for-stage', 'default', { permissionCeiling: 'runtime-default' });
    expect(heldMessageMayJoin(runtime, 'held-for-stage', 'stage')).toBe(false);
  });
});

describe('launchCeiling', () => {
  it('adds the runtime default for a held row, once', () => {
    expect(launchCeiling('client-a', 'm1', undefined, true)).toBe('runtime-default');
    expect(launchCeiling('client-a', 'm1', 'runtime-default', true)).toBe('runtime-default');
    const level = { asks: 'when-risky', reach: 'edit' } as const;
    expect(launchCeiling('client-a', 'm1', level, true)).toEqual([level, 'runtime-default']);
  });

  it('leaves a row nobody held alone', () => {
    expect(launchCeiling('client-a', 'm1', undefined, false)).toBeUndefined();
  });
});

describe('a held queue row', () => {
  it('keeps its hold through an edit, and an edit from Wi-Fi adds one', () => {
    const store = new MessageQueueStore(createTestDb());
    const held = store.enqueue({
      sessionId: 's',
      content: 'a',
      clientId: 'c',
      heldToDefault: true,
    });
    expect(store.updateContent(held.id, 'b')?.heldToDefault).toBe(true);

    const plain = store.enqueue({ sessionId: 's', content: 'x', clientId: 'c' });
    expect(plain.heldToDefault).toBe(false);
    expect(store.updateContent(plain.id, 'y', { holdToDefault: true })?.heldToDefault).toBe(true);
    expect(store.get(plain.id)?.heldToDefault).toBe(true);
  });
});
