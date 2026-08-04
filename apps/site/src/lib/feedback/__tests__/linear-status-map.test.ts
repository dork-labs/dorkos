import { describe, expect, it } from 'vitest';

import { mapLinearStateToStatus, resolveShippedVersion } from '../linear-status-map';

describe('mapLinearStateToStatus', () => {
  it('maps every canonical Linear state type to a cockpit status', () => {
    expect(mapLinearStateToStatus({ type: 'triage' })).toBe('triaged');
    expect(mapLinearStateToStatus({ type: 'backlog' })).toBe('triaged');
    expect(mapLinearStateToStatus({ type: 'unstarted' })).toBe('triaged');
    expect(mapLinearStateToStatus({ type: 'started' })).toBe('in_progress');
    expect(mapLinearStateToStatus({ type: 'completed' })).toBe('shipped');
    expect(mapLinearStateToStatus({ type: 'canceled' })).toBe('closed');
    expect(mapLinearStateToStatus({ type: 'cancelled' })).toBe('closed');
  });

  it('is not a 1:1 mirror — several Linear types collapse into "triaged"', () => {
    const collapsed = new Set(
      ['triage', 'backlog', 'unstarted'].map((type) => mapLinearStateToStatus({ type }))
    );
    expect(collapsed).toEqual(new Set(['triaged']));
  });

  it('type mapping is case-insensitive', () => {
    expect(mapLinearStateToStatus({ type: 'STARTED' })).toBe('in_progress');
  });

  it('prefers type over name when both are present', () => {
    expect(mapLinearStateToStatus({ type: 'completed', name: 'Some Custom Name' })).toBe('shipped');
  });

  it('falls back to name when type is absent', () => {
    expect(mapLinearStateToStatus({ name: 'In Progress' })).toBe('in_progress');
    expect(mapLinearStateToStatus({ name: 'Done' })).toBe('shipped');
    expect(mapLinearStateToStatus({ name: 'Duplicate' })).toBe('closed');
  });

  it('name fallback is case-insensitive', () => {
    expect(mapLinearStateToStatus({ name: 'done' })).toBe('shipped');
  });

  it('resolves undefined for an unrecognized type with no usable name', () => {
    expect(mapLinearStateToStatus({ type: 'some-future-type' })).toBeUndefined();
  });

  it('resolves undefined for an unrecognized name', () => {
    expect(mapLinearStateToStatus({ name: 'Some Custom Renamed State' })).toBeUndefined();
  });

  it('resolves undefined when state is absent entirely', () => {
    expect(mapLinearStateToStatus(undefined)).toBeUndefined();
  });
});

describe('resolveShippedVersion', () => {
  it('prefers the project milestone name', () => {
    expect(
      resolveShippedVersion({
        projectMilestone: { name: '0.56.3' },
        cycle: { name: 'Cycle 12' },
      })
    ).toBe('0.56.3');
  });

  it('falls back to the cycle name when there is no milestone', () => {
    expect(resolveShippedVersion({ cycle: { name: 'Cycle 12' } })).toBe('Cycle 12');
  });

  it('resolves undefined when neither is set', () => {
    expect(resolveShippedVersion({})).toBeUndefined();
    expect(resolveShippedVersion({ projectMilestone: null, cycle: null })).toBeUndefined();
  });
});
