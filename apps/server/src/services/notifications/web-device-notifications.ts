/**
 * What DorkOS tells the owner when a browser it has never seen uses chat from
 * the web on this computer, over the owner's hub (spec `everything-is-a-space`
 * step B3, DOR-2946). The emitter is `services/core/session-relay/relay-devices.ts`.
 *
 * Declared here and spread into the registry, like `connector-hold-notifications.ts`.
 *
 * One row per browser, ever: the emitter raises it only the first time a
 * device id is seen, and the dedupe key is the device, so a repeat cannot
 * slip through either. At most five an hour: past that, one row says several
 * did, for that hour. A row names the hub's label for the browser and a short
 * hash of its id, never the id and never anything it said: it is what a
 * phone's lock screen shows.
 *
 * @module services/notifications/web-device-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface WebDevicePayloads {
  /**
   * A browser this computer had never seen used chat from the web here; or,
   * past the hourly cap, several did, said once for that hour.
   */
  'web.new_device':
    | {
        /** A short hash of the hub's id for the browser, never the id itself. The subject. */
        deviceRef: string;
        /** What the hub calls it, e.g. `Safari on iPhone`. */
        label: string;
      }
    | {
        /** When the hour this notice speaks for began (ISO 8601). The subject. */
        severalSince: string;
      };
}

/** The remedy every row names: the one switch that stops it now. */
const REMEDY = 'Not you? Pause it in Settings now.';

/** The one entry, spread into the registry's `ENTRIES`. */
export const WEB_DEVICE_ENTRIES: {
  [K in keyof WebDevicePayloads]: NotificationRegistryEntry<K>;
} = {
  'web.new_device': {
    kind: 'web.new_device',
    // Notable: nothing waits on a person, but the owner should see it.
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: 'deviceRef' in p ? p.deviceRef : `several:${p.severalSince}` }),
    title: (p) =>
      'deviceRef' in p
        ? 'New device used chat from the web'
        : 'Several new devices used chat from the web',
    body: (p) => ('deviceRef' in p ? `${p.label}. ${REMEDY}` : REMEDY),
    dedupeKey: (p) =>
      'deviceRef' in p ? `web-device:${p.deviceRef}` : `web-device-several:${p.severalSince}`,
    relay: 'never',
  },
};
