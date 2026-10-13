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

  // Spec trusted-by-default-flip §5.6: the waiting row opens where Cancel is;
  // the row saying how it ended opens the chat the agent asked from.
  it('takes a held action to the Inbox while it waits, and to its chat once it ended', () => {
    const waiting: NotificationDTO = {
      id: '01JZG0000000000000000011',
      kind: 'connector.destructive_pending',
      tier: 'notable',
      subject: { type: 'system', id: 'hold-1' },
      sessionId: 'session-1',
      title: 'Scout will run “Delete message” in Gmail',
      actions: [
        { id: 'cancel', label: 'Cancel', style: 'danger' },
        { id: 'open', label: 'Open', style: 'primary' },
      ],
      createdAt: '2026-10-13T12:00:00.000Z',
    };
    expect(notificationLink(waiting)).toEqual({ to: '/', search: { inbox: 'hold-1' } });
    expect(
      notificationLink({ ...waiting, actions: [{ id: 'open', label: 'Open', style: 'primary' }] })
    ).toMatchObject({ search: { session: 'session-1' } });
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

  // DOR-2543. The subject is the owner's connection ref; the row opens that community's page,
  // where the banner says what to do.
  it('takes an owner-replacement row to the community it is about', () => {
    const row: NotificationDTO = {
      id: '01JZG0000000000000000010',
      kind: 'community.owner-replacement',
      tier: 'notable',
      subject: { type: 'system', id: 'remote_owner_a' },
      title: 'Someone asked to take over Night shift',
      createdAt: '2026-09-28T12:00:00.000Z',
    };
    expect(notificationLink(row)).toEqual({
      to: '/channels',
      search: { community: 'remote_owner_a' },
    });
  });

  // Spec heartbeats §6.3. The offer's card is on every agent's Heartbeat page.
  it('takes the credits offer to the team, where its agents are', () => {
    const row: NotificationDTO = {
      id: '01JZG0000000000000000011',
      kind: 'heartbeat.credits-offer',
      tier: 'quiet',
      subject: { type: 'system', id: 'heartbeat-credits-offer' },
      title: 'Run cheap checks on DorkOS credits?',
      createdAt: '2026-10-10T12:00:00.000Z',
    };
    expect(notificationLink(row)).toEqual({ to: '/team', search: {} });
  });
});
