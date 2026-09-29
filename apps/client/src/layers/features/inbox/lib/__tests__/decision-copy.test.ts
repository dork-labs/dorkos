/**
 * The words core draws around an extension's decision (spec
 * `flow-multiproject` §7.1, §7.4, V2).
 */
import { describe, it, expect } from 'vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { deadlineLine, decisionHistoryTrail, sinceLine } from '../decision-copy';

const NOW = new Date(2026, 8, 29, 9, 0);
const at = (h: number, m = 0, day = 29) => new Date(2026, 8, day, h, m).toISOString();

describe('deadlineLine', () => {
  it('names the time and the agent’s pick', () => {
    const line = deadlineLine(at(17), 'Keep it', NOW);
    expect(line).toMatch(/^If you don’t answer by .+, the agent picks “Keep it”\.$/);
    expect(line).not.toMatch(/Tue|Wed/);
  });

  it('names the day when it is not today', () => {
    expect(deadlineLine(at(17, 0, 30), 'Keep it', NOW)).toMatch(/by \S+ /);
  });

  it('never names a deadline in the past', () => {
    expect(deadlineLine(at(8), 'Keep it', NOW)).toBe(
      'The agent picks “Keep it” any moment now, unless you answer.'
    );
  });

  it('says nothing without a deadline or a pick', () => {
    expect(deadlineLine(undefined, 'Keep it', NOW)).toBeNull();
    expect(deadlineLine(at(17), null, NOW)).toBeNull();
  });
});

describe('sinceLine', () => {
  it('says when it began and how long it waited to ask', () => {
    expect(sinceLine(at(7, 14), at(8, 14), NOW)).toMatch(/^since .+ · asked after 1h$/);
  });

  it('leaves out "asked after" when it asked at once, and says nothing without a start', () => {
    expect(sinceLine(at(8), at(8), NOW)).toMatch(/^since [^·]+$/);
    expect(sinceLine(null, at(8), NOW)).toBeNull();
  });
});

describe('decisionHistoryTrail', () => {
  const row = (overrides: Partial<NotificationDTO>): NotificationDTO => ({
    id: '01J0000000000000000000000N',
    kind: 'extension.decision',
    tier: 'blocking',
    subject: { type: 'system', id: '01J0000000000000000000000D' },
    title: 'Ship it?',
    createdAt: at(14, 14),
    resolvedAt: at(14, 14),
    ...overrides,
  });

  it('adds the time to who decided', () => {
    expect(decisionHistoryTrail(row({ body: 'Ship it · you', outcome: 'approved' }), NOW)).toMatch(
      /^Ship it · you at .+$/
    );
    expect(
      decisionHistoryTrail(row({ body: 'Resolved on its own', outcome: 'cleared' }), NOW)
    ).toMatch(/^Resolved on its own at .+$/);
  });

  it('says "on <day>" for an answer on another day, never "at Sep 12"', () => {
    const trail = decisionHistoryTrail(
      row({ body: 'Ship it · you', outcome: 'approved', resolvedAt: at(14, 0, 12) }),
      NOW
    );
    expect(trail).toMatch(/^Ship it · you on \S+ 12$/);
  });

  it('says only "No longer needed" for a withdrawn decision', () => {
    expect(decisionHistoryTrail(row({ body: 'No longer needed', outcome: 'cancelled' }), NOW)).toBe(
      'No longer needed'
    );
  });
});
