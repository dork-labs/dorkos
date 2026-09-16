/**
 * The boot-time re-arm of parked schedules must run through the same
 * "does this genuinely need the operator" gate the client's approval card
 * uses (DOR-2059), or a schedule a package shipped switched off would go
 * quiet everywhere else and still buzz a phone after every restart.
 *
 * `needsScheduleApprovalAttention` has its own unit tests
 * (`services/tasks/__tests__/schedule-permission-clamp.test.ts`), but nothing
 * else asserted it is actually the filter `index.ts` re-arms from — dropping
 * the call there, or reverting to a bare `status === 'pending_approval'`
 * check, would be caught by nothing (adversarial review). Read the source
 * statically, the way `connector-agent-cleanup-wiring.test.ts` proves its own
 * boot-time ordering — the alternative is a full server boot in a test, which
 * this repo does not otherwise pay for just to pin a `.filter(...)` call.
 *
 * @module __tests__/schedule-rearm-wiring
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('schedule boot re-arm wiring', () => {
  it('imports needsScheduleApprovalAttention from the module the client mirrors', () => {
    expect(source).toMatch(
      /import\s*\{\s*needsScheduleApprovalAttention\s*\}\s*from\s*'\.\/services\/tasks\/schedule-permission-clamp\.js'/
    );
  });

  it('filters the boot-time re-arm list through it, before the escalation service is armed', () => {
    const stillParked = source.indexOf('const stillParked');
    const filterCall = source.indexOf('.filter((task) => needsScheduleApprovalAttention(task))');
    const rearm = source.indexOf('getEscalationService()?.rearmFromStandingState(stillParked)');

    expect(stillParked).toBeGreaterThan(-1);
    expect(filterCall).toBeGreaterThan(stillParked);
    expect(rearm).toBeGreaterThan(filterCall);
  });

  it('does not fall back to a bare `pending_approval` check on the same list', () => {
    // The regression this guards against: reverting the filter to
    // `task.status === 'pending_approval'` alone would re-arm an escalation
    // for an off-shipped package schedule on every restart.
    const rearmBlockStart = source.indexOf('const stillParked');
    const rearmBlockEnd = source.indexOf(
      'getEscalationService()?.rearmFromStandingState(stillParked)'
    );
    const rearmBlock = source.slice(rearmBlockStart, rearmBlockEnd);

    expect(rearmBlock).not.toMatch(/\.filter\(\(task\) => task\.status === 'pending_approval'\)/);
  });
});
