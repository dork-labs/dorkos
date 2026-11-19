/**
 * The registry that counts a Codex agent's running heavy commands (DOR-4743), on its own: a gate
 * the test writes, a clock the test moves, and a sink the test reads. What only the registry can
 * show cheaply lives here; the counting itself is proven over the real transport in
 * `load-gate-hold.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import type { HeldSlot, LoadGate } from '../../../../core/load-gate/load-gate.js';
import type { ServerNotification } from '../protocol/methods.js';
import type { TurnSink } from '../thread-channel.js';
import { CodexRunningCommands } from '../running-commands.js';

const POLL = 5_000;

/** A slot whose refreshes the test counts. */
function countedSlot(): HeldSlot {
  return { waitedMs: 0, outcome: 'ran', heartbeat: vi.fn(() => true), release: vi.fn() };
}

/** A gate that hands every running command `slot`. */
function gateGiving(slot: HeldSlot): LoadGate {
  return {
    waitForSlot: vi.fn(),
    gateIfHeavy: vi.fn(async () => null),
    occupy: vi.fn(() => slot),
    waitWhileBusy: vi.fn(async () => {}),
    waitingJobs: () => [],
  };
}

/** An open turn that never ends while the test reads it. */
const openTurn = () => ({ sessionId: 'ana', completed: new Promise<string>(() => {}) });

/** A turn's sink, and what it hands each notification on to (watching wraps `notify` in place). */
function sink() {
  const handedOn = vi.fn();
  const turnSink: TurnSink = { turnId: 't-1', notify: handedOn, closed: vi.fn() };
  return { turnSink, handedOn };
}

const started = (itemId: string) =>
  ({
    method: 'item/started',
    params: { item: { type: 'commandExecution', id: itemId, command: 'pnpm build' } },
  }) as unknown as ServerNotification;

const chunk = (itemId: string) =>
  ({
    method: 'item/commandExecution/outputDelta',
    params: { itemId, delta: 'compiling…\n' },
  }) as unknown as ServerNotification;

describe('CodexRunningCommands', () => {
  it('refreshes a talking command’s slot at most once a poll, however many chunks it prints', () => {
    let now = 0;
    const slot = countedSlot();
    const running = new CodexRunningCommands({ gate: () => gateGiving(slot), now: () => now });
    const { turnSink, handedOn } = sink();
    const watched = running.watch(turnSink, openTurn());
    watched.notify(started('a-1'));
    // Within the poll it was taken in: taking it counts as a refresh.
    for (let i = 0; i < 20; i += 1) watched.notify(chunk('a-1'));
    expect(slot.heartbeat).not.toHaveBeenCalled();

    now = POLL;
    for (let i = 0; i < 50; i += 1) watched.notify(chunk('a-1'));
    expect(slot.heartbeat).toHaveBeenCalledTimes(1);

    now = 2 * POLL;
    watched.notify(chunk('a-1'));
    expect(slot.heartbeat).toHaveBeenCalledTimes(2);
    // Every chunk still reached the turn.
    expect(handedOn).toHaveBeenCalledTimes(1 + 20 + 50 + 1);
  });

  it('a failure to count never costs the turn a notification, and is logged once, naming no command', () => {
    const log = { warn: vi.fn() };
    const running = new CodexRunningCommands({ gate: () => gateGiving(countedSlot()), log });
    const { turnSink, handedOn } = sink();
    const watched = running.watch(turnSink, openTurn());
    const unreadable = {
      method: 'item/started',
      get params(): unknown {
        throw new Error('pnpm build --filter secret-project');
      },
    } as unknown as ServerNotification;
    watched.notify(unreadable);
    watched.notify(unreadable);
    expect(handedOn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { error: 'Error' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret|pnpm/);
  });
});
