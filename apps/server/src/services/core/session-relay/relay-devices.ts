/**
 * The browsers that have used chat from the web on this computer (spec
 * `everything-is-a-space` step B3, DOR-2946), kept in
 * `<dorkHome>/session-relay/devices.json`, owner-only (0600) and written
 * whole and atomically.
 *
 * The hub names the browser on each relayed request (`device` in
 * `@dorkos/shared/session-relay`); this computer only remembers it. The first
 * time an id arrives, {@link RelayDeviceStoreOptions.onNewDevice} runs once,
 * which the live store turns into one notification and one audit entry. A
 * device is never told about twice: the list changes in memory the moment a
 * request names it, before the write, so two requests at once from a new
 * browser cannot both find it new.
 *
 * Capped at {@link RELAY_DEVICES_MAX}: past it the device seen longest ago is
 * dropped, and would be new again. A file that cannot be read starts an empty
 * list, so at worst the owner hears about a browser twice.
 *
 * Nothing here decides what a device may do. The relay serves the owner's
 * hub, whatever browser the hub names.
 *
 * @module services/core/session-relay/relay-devices
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { RelayDeviceSchema, type RelayDevice } from '@dorkos/shared/session-relay';
import type { SessionRelayDevice } from '@dorkos/shared/session-relay-link';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import type { RelayAuditEntry } from './relay-audit.js';

/** The most devices remembered; the one seen longest ago goes first. */
export const RELAY_DEVICES_MAX = 50;

/** A known device's last-seen time is written at most this often. */
export const RELAY_DEVICE_TOUCH_MS = 60_000;

/** Where the list lives, inside the data folder. */
const FILE = path.join('session-relay', 'devices.json');

/** Owner read and write only. */
const FILE_MODE = 0o600;

/** One remembered device. */
const RecordSchema = RelayDeviceSchema.extend({
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

/** One remembered device, id included. */
export type RelayDeviceRecord = z.infer<typeof RecordSchema>;

const FileSchema = z.strictObject({ v: z.literal(1), devices: z.array(RecordSchema) });

/** What a store reads and calls. */
export interface RelayDeviceStoreOptions {
  /** The data folder; the live one by default. */
  dorkHome?: string;
  /** The clock; injectable for tests. */
  now?: () => number;
  /** Called once for a device this computer has never seen. Never throws out. */
  onNewDevice?: (device: RelayDevice) => void;
}

/** The devices this computer has seen, in memory and on disk. */
export class RelayDeviceStore {
  private devices: RelayDeviceRecord[] | null = null;
  /** When each device's record was last written. */
  private readonly writtenAt = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  /**
   * Hold the store's options. Nothing is read until first use.
   *
   * @param options - See {@link RelayDeviceStoreOptions}.
   */
  constructor(private readonly options: RelayDeviceStoreOptions = {}) {}

  /** The file's path. */
  get file(): string {
    return path.join(this.options.dorkHome ?? resolveDorkHome(), FILE);
  }

  /** Every remembered device, most recently seen first, without its id. */
  list(): SessionRelayDevice[] {
    return this.load().map(({ label, firstSeenAt, lastSeenAt }) => ({
      label,
      firstSeenAt,
      lastSeenAt,
    }));
  }

  /**
   * A relayed request named this device: remember it, and tell the owner when
   * it is new. Returns whether it was new; the write finishes in the
   * background ({@link flush} waits for it).
   *
   * @param device - The device the hub named, already checked by the protocol.
   */
  seen(device: RelayDevice): boolean {
    const devices = this.load();
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const index = devices.findIndex((known) => known.id === device.id);
    if (index >= 0) {
      const [known] = devices.splice(index, 1);
      devices.unshift({ ...known!, label: device.label, lastSeenAt: now });
      const last = this.writtenAt.get(device.id) ?? 0;
      if (nowMs - last >= RELAY_DEVICE_TOUCH_MS || known!.label !== device.label) {
        this.save(device.id, nowMs);
      }
      return false;
    }
    devices.unshift({ ...device, firstSeenAt: now, lastSeenAt: now });
    for (const dropped of devices.splice(RELAY_DEVICES_MAX)) this.writtenAt.delete(dropped.id);
    this.save(device.id, nowMs);
    try {
      this.options.onNewDevice?.(device);
    } catch (error) {
      logger.warn('[SessionRelay] Could not tell the owner about a new device', {
        error: (error as Error).name,
      });
    }
    return true;
  }

  /** Wait for every write so far. */
  flush(): Promise<void> {
    return this.queue;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The list, read from disk once. Most recently seen first. */
  private load(): RelayDeviceRecord[] {
    if (this.devices) return this.devices;
    this.devices = [];
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.devices;
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        this.devices = parsed.data.devices
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          .slice(0, RELAY_DEVICES_MAX);
        return this.devices;
      }
    } catch {
      // Falls through to the warning below.
    }
    logger.warn('[SessionRelay] The list of devices could not be read; starting a new one');
    return this.devices;
  }

  /** Write the whole list after any write already queued. */
  private save(deviceId: string, nowMs: number): void {
    this.writtenAt.set(deviceId, nowMs);
    const write = async (): Promise<void> => {
      const text = JSON.stringify({ v: 1, devices: this.devices ?? [] });
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, text, { mode: FILE_MODE });
    };
    this.queue = this.queue.then(write).catch((error: unknown) => {
      logger.warn('[SessionRelay] Could not save the list of devices', {
        error: (error as Error).name,
      });
    });
  }
}

/** At most this many new-device notices an hour; past it, one says several did. */
export const RELAY_DEVICE_NOTICES_PER_HOUR = 5;

const HOUR_MS = 60 * 60 * 1000;

/**
 * A short, stable stand-in for a device id wherever it leaves the devices
 * file (the audit log, a notification): the first 16 characters of its
 * SHA-256, base64url. Enough to tell devices apart, never the id itself.
 *
 * @param deviceId - The hub's id for the browser.
 */
export function relayDeviceRef(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('base64url').slice(0, 16);
}

/** What a new-device notice says: one browser, or several past the hourly cap. */
export type NewDeviceNotice = { deviceRef: string; label: string } | { severalSince: string };

/** Where a new device is announced. */
export interface NewDeviceAnnouncerDeps {
  /** Raise the owner's `web.new_device` notification. */
  notify: (notice: NewDeviceNotice) => Promise<unknown>;
  /** Record one relayed action as the owner. */
  audit: (entry: RelayAuditEntry) => void;
  /** The clock; injectable for tests. */
  now?: () => number;
}

/**
 * Tell the owner about a new device: one audit entry for every device, and a
 * notification for each of the first {@link RELAY_DEVICE_NOTICES_PER_HOUR} in
 * any hour. Past that, one notice says several did, once for that hour, and
 * the rest are recorded silently, so a burst cannot flood the owner's phone.
 * Each names the hub's label and a hash of the id ({@link relayDeviceRef}),
 * never the id and nothing said. For {@link RelayDeviceStoreOptions.onNewDevice}.
 *
 * @param deps - See {@link NewDeviceAnnouncerDeps}.
 */
export function announceNewDevice(deps: NewDeviceAnnouncerDeps): (device: RelayDevice) => void {
  /** When each notice in the last hour went out. */
  let sent: number[] = [];
  /** When the last "several" notice went out. */
  let severalAt: number | null = null;
  const raise = (notice: NewDeviceNotice): void => {
    void deps.notify(notice).catch((error: unknown) => {
      logger.warn('[SessionRelay] Could not raise the new device notice', {
        error: (error as Error).name,
      });
    });
  };
  return (device) => {
    const now = (deps.now ?? Date.now)();
    const deviceRef = relayDeviceRef(device.id);
    sent = sent.filter((at) => now - at < HOUR_MS);
    if (sent.length < RELAY_DEVICE_NOTICES_PER_HOUR) {
      sent.push(now);
      raise({ deviceRef, label: device.label });
    } else if (severalAt === null || now - severalAt >= HOUR_MS) {
      severalAt = now;
      raise({ severalSince: new Date(now).toISOString() });
    }
    deps.audit({
      action: 'relay.device.new',
      operation: 'access',
      outcome: 'ok',
      summary: `A new device used chat from the web: ${device.label}`,
      target: { type: 'device', id: deviceRef },
    });
  };
}
