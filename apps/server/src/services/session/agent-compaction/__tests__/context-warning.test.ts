/**
 * The early context warning (DOR-2732): once per crossing of the line, on the
 * NEXT turn, re-armed only when the conversation falls back below it.
 *
 * The tracker is driven directly for the crossing rules, and through the real
 * dispatcher for the one claim that matters to an agent: the note rides the
 * turn after the crossing, and only that one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

vi.mock('../../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  clearOwedContextWarning,
  noteContextReading,
  percentOfContext,
  resetContextWarnings,
  takeContextWarning,
} from '../context-warning.js';
import { dispatchMessage, resetMessageDispatcher } from '../../message-dispatcher.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';

const MAX = 200_000;
/** A reading at `percent` of a 200k window. */
const at = (percent: number) => ({ totalTokens: (MAX * percent) / 100, maxTokens: MAX });

let session: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  session = `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
  resetContextWarnings();
});

afterEach(() => {
  resetContextWarnings();
});

describe('context warning — the crossing rules', () => {
  it('owes nothing below the line', () => {
    noteContextReading(session, at(79));
    expect(takeContextWarning(session)).toBeNull();
  });

  it('owes the note once when a reading crosses the line, and only once', () => {
    noteContextReading(session, at(81));
    expect(takeContextWarning(session)).toBe(81);
    expect(takeContextWarning(session)).toBeNull();
    // Still over the line on later turns: not told again.
    noteContextReading(session, at(85));
    noteContextReading(session, at(90));
    expect(takeContextWarning(session)).toBeNull();
  });

  it('re-arms only after a reading falls back below the line', () => {
    noteContextReading(session, at(82));
    expect(takeContextWarning(session)).toBe(82);
    noteContextReading(session, at(30)); // after a summary
    noteContextReading(session, at(80));
    expect(takeContextWarning(session)).toBe(80);
  });

  it('drops an owed note when the conversation is summarized, without re-arming', () => {
    noteContextReading(session, at(89));
    clearOwedContextWarning(session);
    expect(takeContextWarning(session)).toBeNull();
    noteContextReading(session, at(89)); // a stale reading after the summary
    expect(takeContextWarning(session)).toBeNull();
  });

  it('ignores a reading with no window size', () => {
    expect(percentOfContext({ totalTokens: 5000, maxTokens: 0 })).toBeNull();
    noteContextReading(session, { totalTokens: 5000, maxTokens: 0 });
    expect(takeContextWarning(session)).toBeNull();
  });
});

describe('context warning — rides the next turn', () => {
  let runtime: FakeAgentRuntime;

  /** The context bag each turn was dispatched with, in order. */
  function bags(): AdditionalContext[] {
    return runtime.sendMessage.mock.calls.map(
      (call) => (call[2] as { additionalContext?: AdditionalContext }).additionalContext ?? []
    );
  }

  /** Run one turn that ends with the conversation at `percent`. */
  async function turnEndingAt(percent: number): Promise<void> {
    const projector = getOrCreateProjector(session);
    runtime.withScenarios([
      async function* () {
        // The reading a runtime reports at the end of its turn, the way every
        // runtime does: a `session_status` carrying the context figures.
        yield {
          type: 'session_status',
          data: { contextTokens: at(percent).totalTokens, contextMaxTokens: MAX },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    await dispatchMessage({
      sessionId: session,
      clientId: 'window-a',
      content: `turn at ${percent}%`,
      projector,
      runtime,
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const warnings = (bag: AdditionalContext) =>
    bag.filter((entry) => entry.kind === 'context_warning');

  beforeEach(() => {
    runtime = new FakeAgentRuntime();
    runtime.getInternalSessionId.mockReturnValue(undefined);
  });

  afterEach(() => {
    resetMessageDispatcher();
    disposeProjector(session);
    vi.restoreAllMocks();
  });

  it('is carried by the turn after the crossing and by no other', async () => {
    await turnEndingAt(70);
    await turnEndingAt(81); // crosses
    await turnEndingAt(86); // carries the note; still over
    await turnEndingAt(88); // over, already told
    await turnEndingAt(40); // a summary brought it down: re-armed
    await turnEndingAt(83); // crosses again
    await turnEndingAt(84); // carries the second note

    const perTurn = bags().map(warnings);
    expect(perTurn.map((entries) => entries.length)).toEqual([0, 0, 1, 0, 0, 0, 1]);
    expect(perTurn[2]![0]).toEqual({
      kind: 'context_warning',
      scope: 'per-turn',
      data: { percent: 81, canCompact: true },
    });
    expect(perTurn[6]![0]).toMatchObject({ data: { percent: 83 } });
  });

  it('tells a runtime that cannot summarize on request not to look for the tool', async () => {
    const supported = runtime.getCapabilities();
    runtime.getCapabilities.mockReturnValue({
      ...supported,
      commandIntents: { compact: { supported: false } },
    } as RuntimeCapabilities);

    await turnEndingAt(90);
    await turnEndingAt(91);

    expect(warnings(bags()[1]!)[0]).toMatchObject({ data: { percent: 90, canCompact: false } });
  });
});
