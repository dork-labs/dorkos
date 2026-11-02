/**
 * Which connected-app writes reach people outside the team (DOR-3683). A turn that read an
 * outsider's words asks a person before one, even at Full autonomy; a draft or a label does not.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { preflightResultOf, writeReachesOutside } from '../reaches-outside.js';

describe('writeReachesOutside', () => {
  it('a send, a reply and a forward reach people outside', () => {
    for (const slug of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_FORWARD_MESSAGE']) {
      expect(writeReachesOutside(slug, { recipient_email: 'a@example.com' }), slug).toBe(true);
    }
  });

  it('a draft, a label and the trash stay in the account', () => {
    for (const slug of [
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_UPDATE_DRAFT',
      'GMAIL_ADD_LABEL_TO_EMAIL',
      'GMAIL_MOVE_TO_TRASH',
      'GMAIL_UNTRASH_MESSAGE',
      'GOOGLECALENDAR_CREATE_CALENDAR',
    ]) {
      expect(writeReachesOutside(slug, { recipient_email: 'a@example.com' }), slug).toBe(false);
    }
  });

  it('a new event reaches people only when it has invitees', () => {
    expect(writeReachesOutside('GOOGLECALENDAR_CREATE_EVENT', { summary: 'Focus' })).toBe(false);
    expect(writeReachesOutside('GOOGLECALENDAR_CREATE_EVENT', { attendees: [] })).toBe(false);
    expect(
      writeReachesOutside('GOOGLECALENDAR_CREATE_EVENT', { attendees: ['a@example.com'] })
    ).toBe(true);
    expect(writeReachesOutside('GOOGLECALENDAR_EVENTS_IMPORT', { guests: 'a@example.com' })).toBe(
      true
    );
  });

  it('a changed event reaches its invitees unless the call sends no updates', () => {
    expect(writeReachesOutside('GOOGLECALENDAR_UPDATE_EVENT', { summary: 'Moved' })).toBe(true);
    expect(
      writeReachesOutside('GOOGLECALENDAR_PATCH_EVENT', { summary: 'Moved', send_updates: 'none' })
    ).toBe(false);
    expect(
      writeReachesOutside('GOOGLECALENDAR_PATCH_EVENT', {
        attendees: ['a@example.com'],
        send_updates: 'none',
      })
    ).toBe(true);
  });

  it('a write it has never seen counts as reaching outside', () => {
    expect(writeReachesOutside('GMAIL_SOMETHING_NEW', {})).toBe(true);
    expect(writeReachesOutside('SLACK_SEND_MESSAGE', {})).toBe(true);
  });
});

describe('preflightResultOf', () => {
  /** The preflight for one call of `slug` in `classification`. */
  const preflightFor = (
    capabilityClassification: 'read' | 'write' | 'destructive',
    operationSlug: string
  ) =>
    preflightResultOf({
      authorityBinding: { approvalScope: { digest: 'd' } },
      serviceAction: { actionName: 'Act', serviceName: 'Gmail' },
      operation: { capabilityClassification, operationSlug },
      arguments: {},
    } as never);

  it('a read reaches nobody, a destructive action cannot be undone, a write is by what it does', () => {
    expect(preflightFor('read', 'GMAIL_LIST_MESSAGES').outward).toBe(false);
    expect(preflightFor('destructive', 'GMAIL_DELETE_LABEL').outward).toBe(true);
    expect(preflightFor('write', 'GMAIL_SEND_EMAIL').outward).toBe(true);
    expect(preflightFor('write', 'GMAIL_CREATE_EMAIL_DRAFT').outward).toBe(false);
  });

  it('carries the authority and the card unchanged', () => {
    expect(preflightFor('write', 'GMAIL_SEND_EMAIL')).toMatchObject({
      authorityBinding: { approvalScope: { digest: 'd' } },
      approvalServiceAction: { actionName: 'Act', serviceName: 'Gmail' },
    });
  });
});
