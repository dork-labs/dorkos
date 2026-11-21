/**
 * A run handed to the relay that nothing answered because the computer slept
 * says so, not "nothing was available to run" (DOR-3286): that sent people
 * looking for a missing runtime or account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishResult, RelayCore } from '@dorkos/relay';
import { createAwakeClock, type AwakeClock } from '@dorkos/shared/awake-clock';
import { sleptDuringRunError } from '@dorkos/shared/schedule-notice-copy';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../task-store.js';
import { RunAccounting } from '../run-accounting.js';
import { dispatchRunViaRelay } from '../relay-dispatch.js';

const NOTHING_ANSWERED: PublishResult = { messageId: 'm', deliveredTo: 0 };
const DELIVERY_TIMEOUT: PublishResult = {
  messageId: 'm',
  deliveredTo: 0,
  adapterResult: { success: false, error: 'adapter delivery timeout (120s)' },
};

let store: TaskStore;

beforeEach(() => {
  store = new TaskStore(createTestDb());
});

/**
 * Hand one scheduled run to a relay that answers `result`, with the computer
 * sleeping `sleptMs` while each publish is in flight.
 */
async function dispatchWhile(result: PublishResult, sleptMs: number) {
  let slept = 0;
  const real = createAwakeClock();
  real.dispose();
  // The computer wakes as each publish returns.
  const clock: AwakeClock = {
    ...real,
    sleptMs: () => slept,
    sleptSince: () => slept,
    lastWakeAt: () => (slept > 0 ? Date.now() : null),
  };
  const relay = {
    publish: vi.fn(async () => {
      slept += sleptMs;
      return result;
    }),
  } as unknown as RelayCore;
  const task = store.createTask({
    name: 'nightly',
    description: 'test',
    prompt: 'test',
    cron: '0 3 * * *',
    filePath: '/tmp/tasks/nightly/SKILL.md',
  });
  const run = store.createRun(task.id, 'scheduled');
  await dispatchRunViaRelay(
    {
      store,
      relay,
      runs: new RunAccounting(store, clock),
      resolveCwd: async () => '/tmp',
      noReceiverRetryMs: 1,
      clock,
    },
    task,
    run,
    { runtimeType: 'claude-code', capabilities: undefined, settings: {} }
  );
  return store.getRun(run.id)!;
}

describe('a relay hand-off the computer slept through', () => {
  it('says the computer slept when nothing answered', async () => {
    const run = await dispatchWhile(NOTHING_ANSWERED, 10 * 60_000);
    expect(run).toMatchObject({ status: 'failed', error: sleptDuringRunError() });
  });

  it('keeps the time-limit line for a delivery deadline, which counts awake time only', async () => {
    // Sleep cannot run that deadline out, and the run may still be going.
    const run = await dispatchWhile(DELIVERY_TIMEOUT, 10 * 60_000);
    expect(run.error).toBe('This run went past its time limit without reporting how it ended.');
  });

  it('keeps the plain reason when the computer stayed awake', async () => {
    const run = await dispatchWhile(NOTHING_ANSWERED, 0);
    expect(run.error).toBe(
      'Nothing was available to run this scheduled task, so the run never started.'
    );
  });

  it('never blames sleep for a refusal it did not cause', async () => {
    const busy: PublishResult = {
      messageId: 'm',
      deliveredTo: 0,
      adapterResult: { success: false, code: 'at_capacity' },
    } as PublishResult;
    const run = await dispatchWhile(busy, 10 * 60_000);
    expect(run.error).toBe('Every agent slot stayed busy, so this run didn’t start.');
  });
});
