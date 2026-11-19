/** A dropped remote confirmation, with the exact device the person can sign out. */
import type { NotificationRegistryEntry } from '../notification-registry.js';

/** The device and request code for one failed remote confirmation episode. */
export interface RemoteStepUpPayloads {
  'step-up.remote-refused': {
    heldActionId: string;
    deviceId: string;
    deviceLabel: string;
    requestCode: string;
  };
}

/** The desk notice and chat message for a remote device’s wrong passwords. */
export const REMOTE_STEP_UP_ENTRIES: {
  'step-up.remote-refused': NotificationRegistryEntry<'step-up.remote-refused'>;
} = {
  'step-up.remote-refused': {
    kind: 'step-up.remote-refused',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.deviceId }),
    title: (p) => `5 wrong passwords from ${p.deviceLabel}`,
    body: (p) =>
      `Nothing was allowed. If that wasn’t you, sign that device out. Request ${p.requestCode}`,
    actions: () => [{ id: 'sign-out-device', label: 'Sign it out', style: 'danger' }],
    dedupeKey: (p) => `remote-step-up:${p.heldActionId}`,
    relay: 'always',
    channelMessage: (p) =>
      `5 wrong passwords from ${p.deviceLabel}. Nothing was allowed. If that wasn’t you, sign that device out. Request ${p.requestCode}`,
  },
};
