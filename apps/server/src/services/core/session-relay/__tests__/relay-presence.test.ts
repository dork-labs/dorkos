/**
 * "Remote session active": true only while the relay is connected and the hub
 * reports a viewer, announced once per change.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionRelayDevice } from '@dorkos/shared/session-relay-link';
import { RelayPresence } from '../relay-presence.js';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');

function tracker(devices: SessionRelayDevice[] = []) {
  const onChange = vi.fn();
  let clock = T0;
  const presence = new RelayPresence({
    devices: { list: () => devices },
    onChange,
    now: () => clock,
  });
  return { presence, onChange, tick: (ms: number) => (clock += ms) };
}

describe('RelayPresence', () => {
  it('is active only while connected with at least one viewer', () => {
    const { presence } = tracker();
    presence.update({ connected: true, viewers: 0 });
    expect(presence.active).toBe(false);
    presence.update({ connected: false, viewers: 3 });
    expect(presence.active).toBe(false);
    presence.update({ connected: true, viewers: 1 });
    expect(presence.active).toBe(true);
    presence.update({ connected: true, viewers: 0 });
    expect(presence.active).toBe(false);
  });

  it('announces each change once, with when it began, and not a repeat', () => {
    const { presence, onChange, tick } = tracker();
    presence.update({ connected: true, viewers: 0 });
    expect(onChange).not.toHaveBeenCalled();
    presence.update({ connected: true, viewers: 1 });
    tick(5_000);
    presence.update({ connected: true, viewers: 2 });
    presence.update({ connected: false, viewers: 0 });
    expect(onChange.mock.calls).toEqual([
      [{ active: true, since: '2026-10-17T10:00:00.000Z', devices: [] }],
      [{ active: false, devices: [] }],
    ]);
  });

  it('lists only the devices seen since it began, and says so once per device', () => {
    const devices = [
      {
        label: 'Safari on iPhone',
        firstSeenAt: '2026-10-17T09:00:00.000Z',
        lastSeenAt: '2026-10-17T10:00:01.000Z',
      },
      {
        label: 'Chrome on Mac',
        firstSeenAt: '2026-10-16T09:00:00.000Z',
        lastSeenAt: '2026-10-16T09:00:00.000Z',
      },
    ];
    const { presence, onChange } = tracker(devices);
    presence.deviceSeen('phone');
    expect(onChange).not.toHaveBeenCalled();
    presence.update({ connected: true, viewers: 1 });
    presence.deviceSeen('phone');
    presence.deviceSeen('phone');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(presence.snapshot().devices.map((d) => d.label)).toEqual(['Safari on iPhone']);
  });
});
