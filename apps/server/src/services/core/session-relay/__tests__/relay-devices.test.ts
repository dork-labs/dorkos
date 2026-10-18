/**
 * The browsers that used chat from the web here: remembered in a 0600 file,
 * capped, and announced to the owner exactly once each.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayDevice } from '@dorkos/shared/session-relay';
import {
  RELAY_DEVICES_MAX,
  RELAY_DEVICE_NOTICES_PER_HOUR,
  RELAY_DEVICE_TOUCH_MS,
  RelayDeviceStore,
  announceNewDevice,
  relayDeviceRef,
} from '../relay-devices.js';
import { WEB_DEVICE_ENTRIES } from '../../../notifications/web-device-notifications.js';

const PHONE = { id: 'phone-browser-01', label: 'Safari on iPhone' };
const LAPTOP = { id: 'laptop-browser-01', label: 'Chrome on Mac' };

let dorkHome: string;
let clock: number;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-devices-'));
  clock = Date.parse('2026-10-17T10:00:00.000Z');
});
afterEach(() => fs.rmSync(dorkHome, { recursive: true, force: true }));

function store(onNewDevice: (device: RelayDevice) => void = vi.fn()) {
  return {
    onNewDevice,
    devices: new RelayDeviceStore({ dorkHome, now: () => clock, onNewDevice }),
  };
}

describe('RelayDeviceStore', () => {
  it('announces a device the first time only, even from a fresh store reading the file', async () => {
    const { devices, onNewDevice } = store();
    expect(devices.seen(PHONE)).toBe(true);
    expect(devices.seen(PHONE)).toBe(false);
    expect(onNewDevice).toHaveBeenCalledTimes(1);
    expect(onNewDevice).toHaveBeenCalledWith(PHONE);
    await devices.flush();

    const later = store();
    expect(later.devices.seen(PHONE)).toBe(false);
    expect(later.onNewDevice).not.toHaveBeenCalled();
    await later.devices.flush();
  });

  it('keeps the file owner-only, and never the device id in what it lists', async () => {
    const { devices } = store();
    devices.seen(PHONE);
    await devices.flush();
    expect(fs.statSync(devices.file).mode & 0o777).toBe(0o600);
    expect(devices.file).toBe(path.join(dorkHome, 'session-relay', 'devices.json'));
    expect(devices.list()).toEqual([
      {
        label: 'Safari on iPhone',
        firstSeenAt: '2026-10-17T10:00:00.000Z',
        lastSeenAt: '2026-10-17T10:00:00.000Z',
      },
    ]);
  });

  it('lists the most recently seen first, and keeps a known device’s first sighting', async () => {
    const { devices } = store();
    devices.seen(PHONE);
    clock += 60_000;
    devices.seen(LAPTOP);
    clock += 60_000;
    devices.seen(PHONE);
    expect(devices.list().map((d) => [d.label, d.firstSeenAt, d.lastSeenAt])).toEqual([
      ['Safari on iPhone', '2026-10-17T10:00:00.000Z', '2026-10-17T10:02:00.000Z'],
      ['Chrome on Mac', '2026-10-17T10:01:00.000Z', '2026-10-17T10:01:00.000Z'],
    ]);
    await devices.flush();
  });

  it('writes a known device’s last sighting at most once a minute', async () => {
    const { devices } = store();
    const saved = () =>
      (JSON.parse(fs.readFileSync(devices.file, 'utf8')) as { devices: { lastSeenAt: string }[] })
        .devices[0]!.lastSeenAt;
    devices.seen(PHONE);
    await devices.flush();
    clock += 1_000;
    devices.seen(PHONE);
    await devices.flush();
    expect(saved()).toBe('2026-10-17T10:00:00.000Z');
    clock += RELAY_DEVICE_TOUCH_MS;
    devices.seen(PHONE);
    await devices.flush();
    expect(saved()).toBe('2026-10-17T10:01:01.000Z');
  });

  it('keeps at most the cap, dropping the one seen longest ago', async () => {
    const { devices, onNewDevice } = store();
    for (let i = 0; i <= RELAY_DEVICES_MAX; i += 1) {
      clock += 1_000;
      devices.seen({ id: `browser-${String(i).padStart(4, '0')}`, label: `Browser ${i}` });
    }
    await devices.flush();
    const saved = JSON.parse(fs.readFileSync(devices.file, 'utf8')) as {
      devices: { id: string }[];
    };
    expect(saved.devices).toHaveLength(RELAY_DEVICES_MAX);
    expect(saved.devices.map((d) => d.id)).not.toContain('browser-0000');
    expect(onNewDevice).toHaveBeenCalledTimes(RELAY_DEVICES_MAX + 1);
  });

  it('starts an empty list from a file it cannot read', async () => {
    fs.mkdirSync(path.join(dorkHome, 'session-relay'), { recursive: true });
    fs.writeFileSync(path.join(dorkHome, 'session-relay', 'devices.json'), '{"v":9}');
    const { devices, onNewDevice } = store();
    expect(devices.list()).toEqual([]);
    devices.seen(PHONE);
    expect(onNewDevice).toHaveBeenCalledTimes(1);
    await devices.flush();
  });

  it('survives an announcer that throws', async () => {
    const { devices } = store(
      vi.fn(() => {
        throw new Error('broken');
      })
    );
    expect(devices.seen(PHONE)).toBe(true);
    await devices.flush();
  });
});

describe('announceNewDevice', () => {
  it('raises one notice and one audit entry naming the label and a hash, never the id', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn();
    const { devices } = store(announceNewDevice({ notify, audit }));
    devices.seen(PHONE);
    devices.seen(PHONE);
    await devices.flush();
    const ref = relayDeviceRef(PHONE.id);
    expect(ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ deviceRef: ref, label: 'Safari on iPhone' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      action: 'relay.device.new',
      operation: 'access',
      outcome: 'ok',
      summary: 'A new device used chat from the web: Safari on iPhone',
      target: { type: 'device', id: ref },
    });
    const said = JSON.stringify([notify.mock.calls, audit.mock.calls]);
    expect(said).not.toContain(PHONE.id);
  });

  it('the notification row carries neither the id nor anything but the hash', () => {
    const entry = WEB_DEVICE_ENTRIES['web.new_device'];
    const payload = { deviceRef: relayDeviceRef(PHONE.id), label: PHONE.label };
    const text = (value: unknown) =>
      typeof value === 'function' ? (value as (p: unknown) => unknown)(payload) : value;
    const row = JSON.stringify([
      entry.locate(payload),
      text(entry.title),
      text(entry.body),
      entry.dedupeKey(payload),
    ]);
    expect(text(entry.body)).toBe('Safari on iPhone. Not you? Pause it in Settings now.');
    expect(row).not.toContain(PHONE.id);
    expect(row).toContain(payload.deviceRef);
  });

  it('says at most five an hour, then one notice for several, then nothing until the hour passes', () => {
    let clock = Date.parse('2026-10-17T10:00:00.000Z');
    const notify = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn();
    const announce = announceNewDevice({ notify, audit, now: () => clock });
    const device = (i: number) => ({ id: `browser-${String(i).padStart(4, '0')}`, label: `B${i}` });
    for (let i = 0; i < RELAY_DEVICE_NOTICES_PER_HOUR + 3; i += 1) {
      clock += 1_000;
      announce(device(i));
    }
    expect(notify).toHaveBeenCalledTimes(RELAY_DEVICE_NOTICES_PER_HOUR + 1);
    expect(notify.mock.calls.at(-1)![0]).toEqual({ severalSince: '2026-10-17T10:00:06.000Z' });
    expect(audit).toHaveBeenCalledTimes(RELAY_DEVICE_NOTICES_PER_HOUR + 3);

    clock += 60 * 60 * 1000;
    announce(device(100));
    expect(notify.mock.calls.at(-1)![0]).toMatchObject({ label: 'B100' });
  });

  it('still audits when the notice cannot be raised', async () => {
    const audit = vi.fn();
    const announce = announceNewDevice({
      notify: vi.fn().mockRejectedValue(new Error('no service')),
      audit,
    });
    announce(PHONE);
    await Promise.resolve();
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
