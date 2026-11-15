/**
 * Every notification kind has a mark and somewhere honest to go — pinned for
 * the kind DOR-2517 added, `extension.approval`.
 */
import { describe, it, expect } from 'vitest';
import { Puzzle, ShieldAlert } from 'lucide-react';
import { NOTIFICATION_KINDS, type NotificationDTO } from '@dorkos/shared/notification-schemas';
import { NOTIFICATION_ICONS, notificationLink } from '../lib/notification-presentation';

it('opens the particular schedule named by its creation notice', () => {
  expect(
    notificationLink({
      id: 'notice',
      kind: 'schedule.armed_by_agent',
      tier: 'notable',
      subject: { type: 'task', id: 'nightly' },
      title: 'Scout made a schedule: Nightly',
      createdAt: '2026-11-03T12:00:00Z',
    })
  ).toEqual({ to: '/tasks', search: { schedule: 'nightly' } });
});

it('opens the exact schedule named by a refusal notice', () => {
  expect(
    notificationLink({
      id: 'notice',
      kind: 'run.completed',
      tier: 'notable',
      subject: { type: 'task', id: 'sample-schedule' },
      title: 'Sample had a command refused',
      createdAt: '2026-11-03T12:00:00Z',
    })
  ).toEqual({ to: '/tasks', search: { schedule: 'sample-schedule' } });
});

describe('notification presentation', () => {
  it('draws a mark for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_ICONS[kind], kind).toBeDefined();
    }
  });

  it('draws an extension waiting to be turned on with the extensions mark', () => {
    expect(NOTIFICATION_ICONS['extension.approval']).toBe(Puzzle);
  });

  // DOR-3292: secret files in an agent's folder are a safety notice, and it
  // opens that agent's Permissions page rather than the whole Team.
  it("draws secret files with the shield and opens the agent's Permissions page", () => {
    expect(NOTIFICATION_ICONS['agent.secret_files']).toBe(ShieldAlert);
    const row: NotificationDTO = {
      id: '01JZG0000000000000000012',
      kind: 'agent.secret_files',
      tier: 'notable',
      subject: { type: 'agent', id: 'scout' },
      agentId: 'scout',
      title: 'Scout can read 3 secret files in its folder',
      createdAt: '2026-10-27T12:00:00.000Z',
    };
    expect(notificationLink(row)).toEqual({
      to: '/team',
      search: { profile: 'scout', profilePage: 'permissions' },
    });
  });

  // DOR-4118: a global server that added a tool opens that server's sheet.
  it("opens the server's sheet when a global MCP server adds a tool", () => {
    const row: NotificationDTO = {
      id: '01JZG0000000000000000013',
      kind: 'mcp-server.tool_added',
      tier: 'notable',
      subject: { type: 'system', id: 'mcp-server:tracker' },
      title: 'tracker added a tool. Quill can use it without asking.',
      createdAt: '2026-11-12T12:00:00.000Z',
    };
    expect(notificationLink(row)).toEqual({
      to: '/connections',
      search: { tab: 'mcp', mcpServer: 'tracker' },
    });
  });

  // DOR-4262: a server named like DorkOS opens its sheet, where the rename is.
  it("opens the server's sheet when a saved server's name is reserved", () => {
    const row: NotificationDTO = {
      id: '01JZG0000000000000000014',
      kind: 'mcp-server.reserved_name',
      tier: 'notable',
      subject: { type: 'system', id: 'mcp-server:DorkOS_Connections' },
      title: 'DorkOS_Connections stopped reaching your agents.',
      createdAt: '2026-11-13T12:00:00.000Z',
    };
    expect(notificationLink(row)).toEqual({
      to: '/connections',
      search: { tab: 'mcp', mcpServer: 'DorkOS_Connections' },
    });
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
