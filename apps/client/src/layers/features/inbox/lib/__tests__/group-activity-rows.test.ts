/**
 * The pure fold that coalesces consecutive same-agent, same-kind, same-tone
 * runs of three or more into one group.
 */
import { describe, it, expect } from 'vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { groupActivityRows, MIN_BURST_SIZE } from '../group-activity-rows';

let counter = 0;

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  counter += 1;
  return {
    id: `01JZG${String(counter).padStart(20, '0')}`,
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: `run-${counter}` },
    agentId: 'alpha',
    title: `run ${counter} finished`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('groupActivityRows', () => {
  it('collapses a run of three or more into one group', () => {
    const rows = [build(), build(), build()];

    const items = groupActivityRows(rows);

    expect(items).toEqual([
      {
        type: 'group',
        id: rows[2].id,
        agentId: 'alpha',
        kind: 'run.completed',
        tone: 'neutral',
        notifications: rows,
      },
    ]);
  });

  it('leaves a run of exactly two as individual rows — the coalescing threshold', () => {
    const rows = [build(), build()];

    const items = groupActivityRows(rows);

    expect(items).toEqual([
      { type: 'row', notification: rows[0] },
      { type: 'row', notification: rows[1] },
    ]);
  });

  it('leaves a single row alone', () => {
    const rows = [build()];

    expect(groupActivityRows(rows)).toEqual([{ type: 'row', notification: rows[0] }]);
  });

  it('MIN_BURST_SIZE is the threshold the fold actually enforces', () => {
    // Pinning the export to the same fold it configures — a change to one
    // that forgets the other would pass every fixed-count test above by
    // accident.
    const rows = Array.from({ length: MIN_BURST_SIZE - 1 }, () => build());
    expect(groupActivityRows(rows).every((item) => item.type === 'row')).toBe(true);

    const rowsAtThreshold = [...rows, build()];
    expect(groupActivityRows(rowsAtThreshold)).toHaveLength(1);
    expect(groupActivityRows(rowsAtThreshold)[0].type).toBe('group');
  });

  it('never groups a notification with no agentId', () => {
    const rows = [
      build({ agentId: undefined, kind: 'update.installed', id: 'u1' }),
      build({ agentId: undefined, kind: 'update.installed', id: 'u2' }),
      build({ agentId: undefined, kind: 'update.installed', id: 'u3' }),
    ];

    const items = groupActivityRows(rows);

    expect(items).toEqual(rows.map((notification) => ({ type: 'row', notification })));
  });

  it('never groups a kind that cannot carry an agentId, even if one is somehow present', () => {
    // No real emitter sets `agentId` on `session.error` — this is a
    // defensive case for the day one does. Without `isGroupableKind`,
    // `notificationBurstVerb` would be called with a kind it has no phrase
    // for and throw once three of these landed; with it, the run just
    // never groups.
    const rows = [
      build({ agentId: 'alpha', kind: 'session.error', tier: 'blocking', id: 's1' }),
      build({ agentId: 'alpha', kind: 'session.error', tier: 'blocking', id: 's2' }),
      build({ agentId: 'alpha', kind: 'session.error', tier: 'blocking', id: 's3' }),
    ];

    const items = groupActivityRows(rows);

    expect(items).toEqual(rows.map((notification) => ({ type: 'row', notification })));
  });

  it('breaks the run when the kind changes mid-stream', () => {
    const rows = [
      build({ kind: 'run.completed' }),
      build({ kind: 'run.completed' }),
      build({ kind: 'turn.completed', tier: 'notable' }),
      build({ kind: 'run.completed' }),
      build({ kind: 'run.completed' }),
    ];

    const items = groupActivityRows(rows);

    // Two singles, one single, two singles — nothing here reaches three.
    expect(items.every((item) => item.type === 'row')).toBe(true);
  });

  it('breaks the run when the agent changes mid-stream', () => {
    const rows = [
      build({ agentId: 'alpha' }),
      build({ agentId: 'alpha' }),
      build({ agentId: 'beta' }),
      build({ agentId: 'alpha' }),
      build({ agentId: 'alpha' }),
    ];

    const items = groupActivityRows(rows);

    expect(items.every((item) => item.type === 'row')).toBe(true);
  });

  it('never folds a failed run into a group of successful ones — tone joins the key', () => {
    // Same agent, same kind, but the middle one failed (tier: notable reads
    // as the error tone via notificationRowTone's isFailedRun override).
    // A tone-blind fold would collapse all five into one deceptively cheerful
    // "finished 5 runs" — the actual member outcomes are 2 quiet, 1 failed, 2 quiet.
    const rows = [
      build({ tier: 'quiet' }),
      build({ tier: 'quiet' }),
      build({ tier: 'notable' }), // failed
      build({ tier: 'quiet' }),
      build({ tier: 'quiet' }),
    ];

    const items = groupActivityRows(rows);

    // Every run here is exactly 2 long (below MIN_BURST_SIZE), so tone
    // splitting the middle failure out of the surrounding successes leaves
    // nothing long enough to group — proving the split happened at all.
    expect(items.every((item) => item.type === 'row')).toBe(true);
    expect(items).toHaveLength(5);
  });

  it('does fold a longer failed-run streak once tone still matches within it', () => {
    const rows = [
      build({ tier: 'quiet' }),
      build({ tier: 'notable' }), // failed
      build({ tier: 'notable' }), // failed
      build({ tier: 'notable' }), // failed
      build({ tier: 'quiet' }),
    ];

    const items = groupActivityRows(rows);

    expect(items).toEqual([
      { type: 'row', notification: rows[0] },
      {
        type: 'group',
        id: rows[3].id,
        agentId: 'alpha',
        kind: 'run.completed',
        tone: 'error',
        notifications: [rows[1], rows[2], rows[3]],
      },
      { type: 'row', notification: rows[4] },
    ]);
  });

  it('keys a group on its OLDEST member, so a live arrival growing it does not change the key', () => {
    const rows = [build(), build(), build()];
    const firstPass = groupActivityRows(rows);
    expect(firstPass).toHaveLength(1);
    const originalId = (firstPass[0] as { id: string }).id;
    expect(originalId).toBe(rows[2].id); // the oldest of the three

    // A live arrival prepends to the FRONT of the source list — this is
    // exactly what `notification-cache.ts`'s upsert does.
    const grown = [build(), ...rows];
    const secondPass = groupActivityRows(grown);
    expect(secondPass).toHaveLength(1);
    expect((secondPass[0] as { id: string }).id).toBe(originalId);
  });
});
