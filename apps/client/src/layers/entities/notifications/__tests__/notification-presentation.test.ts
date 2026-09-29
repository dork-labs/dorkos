/**
 * Every notification kind has a mark and somewhere honest to go — pinned for
 * the kind DOR-2517 added, `extension.approval`.
 */
import { describe, it, expect } from 'vitest';
import { Puzzle } from 'lucide-react';
import { NOTIFICATION_KINDS, type NotificationDTO } from '@dorkos/shared/notification-schemas';
import { NOTIFICATION_ICONS, notificationLink } from '../lib/notification-presentation';

describe('notification presentation', () => {
  it('draws a mark for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_ICONS[kind], kind).toBeDefined();
    }
  });

  it('draws an extension waiting to be turned on with the extensions mark', () => {
    expect(NOTIFICATION_ICONS['extension.approval']).toBe(Puzzle);
  });

  it('takes an extension approval row to Settings → Extensions', () => {
    const row: NotificationDTO = {
      id: '01JZG0000000000000000009',
      kind: 'extension.approval',
      tier: 'notable',
      subject: { type: 'system', id: '{"id":"flow","path":"/p","plugin":null,"version":"1.2.0"}' },
      title: 'Flow is off for now',
      createdAt: '2026-09-28T12:00:00.000Z',
      outcome: 'dismissed',
    };
    expect(notificationLink(row)).toEqual({ to: '/', search: { settings: 'extensions' } });
  });
});
