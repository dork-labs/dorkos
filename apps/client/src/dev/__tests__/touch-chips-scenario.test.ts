/**
 * What the touch-chips simulator scenario promises.
 *
 * The scenario exists to be watched, and nothing in a test can watch it. What a
 * test can do is check that the transcript it plays actually contains the
 * things a reviewer is being asked to look at: a burst tight enough to fill the
 * live row, a gap long enough to prove the loops stop, a file that is read and
 * then changed, a deletion, links that fold into one chip, and a command that
 * runs long enough to see. A scenario that quietly stopped containing one of
 * those would still play, and still show nothing.
 */
import { describe, it, expect } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { accumulateTouchChips, type TouchChip } from '@/layers/features/chat/lib/touch-chips';
import { SCENARIOS } from '../simulator';
import { touchChips } from '../simulator/scenarios/touch-chips';
import type { SimScenario } from '../simulator/sim-types';

/**
 * The message parts a scenario ends up having produced, and when each tool
 * arrived. Mirrors the two step types that make tool calls — appending one and
 * patching it — which is all this scenario uses.
 */
function replay(scenario: SimScenario): { parts: MessagePart[]; arrivals: number[] } {
  const parts: MessagePart[] = [];
  const arrivals: number[] = [];
  let clock = 0;

  for (const step of scenario.steps) {
    clock += step.delayMs ?? 0;
    if (step.type === 'append_tool_call') {
      arrivals.push(clock);
      parts.push({
        type: 'tool_call',
        toolCallId: step.toolCall.toolCallId,
        toolName: step.toolCall.toolName,
        input: step.toolCall.input,
        status: step.toolCall.status,
      } as MessagePart);
    }
    if (step.type === 'update_tool_call') {
      const index = parts.findIndex(
        (part) => part.type === 'tool_call' && part.toolCallId === step.toolCallId
      );
      expect(index, `patch for a tool call that was never appended: ${step.toolCallId}`).not.toBe(
        -1
      );
      parts[index] = { ...parts[index], ...step.patch } as MessagePart;
    }
  }

  return { parts, arrivals };
}

/** The chip for one target, or a readable failure. */
function byTarget(chips: TouchChip[], fullTarget: string): TouchChip {
  const found = chips.find((chip) => chip.fullTarget === fullTarget);
  expect(found, `no chip for ${fullTarget}`).toBeDefined();
  return found as TouchChip;
}

const { parts, arrivals } = replay(touchChips);
const chips = accumulateTouchChips(parts);

describe('the touch-chips scenario', () => {
  it('is registered, once', () => {
    expect(SCENARIOS.filter((scenario) => scenario.id === touchChips.id)).toHaveLength(1);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it('opens with three tools inside a second, so the live row fills at once', () => {
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    expect(arrivals[2] - arrivals[0]).toBeLessThanOrEqual(1200);
  });

  it('goes quiet for ten seconds, so every loop can be seen to stop', () => {
    const gaps = arrivals.slice(1).map((at, index) => at - arrivals[index]);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(10000);
  });

  it('touches more than the live row holds, so chips are absorbed into the pile', () => {
    expect(chips.length).toBeGreaterThan(4);
  });

  it('reads a file and then changes it, which is the upgrade morph', () => {
    const mapper = byTarget(chips, '/repo/src/event-mapper.ts');

    expect(mapper.verb).toBe('edit');
    expect(mapper.upgraded).toBe(true);
    expect(mapper.touches).toBe(3);
    expect(mapper.additions).toBeGreaterThan(0);
  });

  it('deletes a file with an rm, which makes both a command chip and a tombstone', () => {
    // The scenario reads the file by its full path and deletes it by a relative
    // one — the exact shape that used to leave a clickable chip for a file that
    // is gone sitting beside its own tombstone. One chip, and it is the grave.
    const tombstone = byTarget(chips, '/repo/src/legacy/event-mapper.ts');
    expect(tombstone.verb).toBe('delete');
    expect(tombstone.touches).toBe(2);
    expect(byTarget(chips, 'rm src/legacy/event-mapper.ts').verb).toBe('run');
  });

  it('creates a file, which carries the lines it wrote', () => {
    const created = byTarget(chips, '/repo/src/derive-event.ts');

    expect(created.verb).toBe('create');
    expect(created.additions).toBeGreaterThan(0);
    expect(created.deletions).toBeUndefined();
  });

  it('fetches two pages that fold into one chip, and one that does not', () => {
    const fetched = chips.filter((chip) => chip.verb === 'fetch');

    expect(fetched).toHaveLength(2);
    // The two MDN links differ only by their fragment: one page, touched twice.
    expect(fetched.find((chip) => chip.label === 'developer.mozilla.org')?.touches).toBe(2);
  });

  it('searches, and glob patterns come through flagged as patterns', () => {
    expect(chips.some((chip) => chip.verb === 'search' && chip.hits === 14)).toBe(true);
    expect(byTarget(chips, 'src/**/*.mapper.ts').pattern).toBe(true);
  });

  it('runs one command long enough to watch its terminal pulse', () => {
    const bash = touchChips.steps.filter(
      (step) => step.type === 'update_tool_call' && step.toolCallId === 'sim-tc-bash'
    );
    const settle = bash[bash.length - 1];

    expect(settle.delayMs ?? 0).toBeGreaterThanOrEqual(5000);
  });

  it('leaves nothing running when it is over', () => {
    expect(chips.filter((chip) => chip.live)).toEqual([]);
  });
});
