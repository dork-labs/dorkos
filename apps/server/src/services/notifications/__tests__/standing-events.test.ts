/**
 * The arrival/resolution signal a standing condition broadcasts to the
 * periphery (DOR-1570), and the one field that decides whether a surface can
 * retire its own banner: `expiresAt`.
 *
 * The whole point of the review fix is that expiry is the one ending the server
 * never announces by itself — so a kind that CAN expire unanswered has to say
 * when, and a kind that cannot must NOT, or a surface would arm a timer against
 * a deadline that never comes. This pins that split at the source rather than
 * leaving it to the call sites.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { eventFanOut } from '../../core/event-fan-out.js';
import { setEscalationService } from '../escalation-service.js';
import { raiseStanding, broadcastStandingResolved } from '../standing-events.js';

let broadcast: MockInstance<typeof eventFanOut.broadcast>;

/** The one broadcast of a given event name, or undefined. */
function eventOf(name: string): Record<string, unknown> | undefined {
  const call = broadcast.mock.calls.find((c) => c[0] === name);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  // No live ladder — `raiseStanding` also arms one, which is a no-op with none set.
  setEscalationService(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('raiseStanding — the arrival', () => {
  it('carries expiresAt for a kind that can expire unanswered, when given one', () => {
    raiseStanding(
      'approval.pending',
      {
        approvalId: '01J1',
        capabilityId: 'tasks_delete',
        capabilityTitle: 'Delete a scheduled task',
        requestedBy: 'Ana',
      },
      { expiresAt: '2026-08-25T12:00:00.000Z' }
    );

    expect(eventOf('standing_pending')).toMatchObject({
      kind: 'approval.pending',
      subjectKey: 'approval:01J1',
      expiresAt: '2026-08-25T12:00:00.000Z',
    });
  });

  it('omits expiresAt for a parked schedule, which has no decision window', () => {
    raiseStanding('schedule.parked', {
      taskId: 'task-1',
      taskName: 'Nightly',
      proposedBy: 'An agent',
    });

    const event = eventOf('standing_pending');
    expect(event).toMatchObject({ kind: 'schedule.parked', subjectKey: 'schedule:task-1' });
    // A schedule resolves only by a decision or a removal, both of which
    // announce — so a surface must NOT arm an expiry timer for it.
    expect(event).not.toHaveProperty('expiresAt');
  });

  it('addresses the arrival to the operator, never to an agent principal', () => {
    raiseStanding('schedule.parked', { taskId: 't', taskName: 'N', proposedBy: 'An agent' });
    const audience = broadcast.mock.calls.find((c) => c[0] === 'standing_pending')?.[2] as
      | ((p: { kind: string }) => boolean)
      | undefined;
    expect(audience?.({ kind: 'agent' })).toBe(false);
    expect(audience?.({ kind: 'operator' })).toBe(true);
  });
});

describe('broadcastStandingResolved — the resolution', () => {
  it('names only the condition, so a surface can retire what it drew', () => {
    broadcastStandingResolved('schedule.parked', 'schedule:task-1');
    expect(eventOf('standing_resolved')).toMatchObject({
      kind: 'schedule.parked',
      subjectKey: 'schedule:task-1',
      resolvedAt: expect.any(String),
    });
  });
});
