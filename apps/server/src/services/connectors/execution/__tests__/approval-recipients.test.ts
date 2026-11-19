/**
 * A send's approval card lists every recipient on its own line, above the glance (DOR-4592,
 * Security): never folded into "and N more", never sorted or deduped, and inert, so a hidden
 * character can't make one address read as another.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SERVICE_MAX_RECIPIENTS,
  APPROVAL_SERVICE_RECIPIENT_MAX_LENGTH,
  type ApprovalServiceAction,
} from '@dorkos/shared/approval-schemas';
import { storableServiceAction } from '../../../core/approvals/approval-storable.js';
import { describeGatedAttempt } from '../../../core/capabilities/tier-enforcement.js';
import { inertRecipient, isRecipientArgumentName } from '../approval-card/recipients.js';
import { describeServiceAction, type ServiceActionFacts } from '../approval-card/service-action.js';

const GMAIL_SCHEMA = {
  type: 'object',
  properties: {
    recipient_email: { type: 'string' },
    extra_recipients: { type: 'array', items: { type: 'string' } },
    cc: { type: 'array', items: { type: 'string' } },
    bcc: { type: 'array', items: { type: 'string' } },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
};

function send(args: Record<string, unknown>): ServiceActionFacts {
  return {
    toolkit: 'gmail',
    connectionLabel: 'Work mail',
    identityHint: 'owner@example.com',
    operationSlug: 'GMAIL_SEND_EMAIL',
    inputSchema: GMAIL_SCHEMA,
    arguments: args,
  };
}

function lines(action: ApprovalServiceAction): string[] {
  return (action.recipients ?? []).map((r) => `${r.label}: ${r.address}`);
}

describe("a send's recipients on its approval card", () => {
  it('lists every recipient of a 7-address send, in order, with nothing folded', () => {
    const action = describeServiceAction(
      send({
        recipient_email: 'ann@example.com',
        extra_recipients: ['bo@example.org', 'cy@example.net'],
        cc: ['di@example.com', 'ed@example.com'],
        bcc: ['fay@example.com', 'gus@example.com'],
        subject: 'Garden note',
        body: 'The made-up garden note.',
      })
    );
    expect(lines(action)).toEqual([
      'Recipient email: ann@example.com',
      'Extra recipients: bo@example.org',
      'Extra recipients: cy@example.net',
      'CC: di@example.com',
      'CC: ed@example.com',
      'BCC: fay@example.com',
      'BCC: gus@example.com',
    ]);
    expect(JSON.stringify(action.details)).not.toContain('more');
    expect(action.details.map((d) => d.label)).toEqual(['Subject', 'Body']);
  });

  it('keeps the order sent and every repeat, so a harmless first address hides nothing', () => {
    const bcc = ['me@example.com', 'me@example.com', 'me@example.com', 'outsider@example.net'];
    const action = describeServiceAction(send({ recipient_email: 'me@example.com', bcc }));
    expect(lines(action).slice(1)).toEqual(bcc.map((address) => `BCC: ${address}`));
  });

  it('shows a bidi override as a visible marker, so the address can’t read as another', () => {
    // "moc.elpmaxe@ann" displayed backwards would read as ann@example.com.
    const spoof = 'evil\u202Emoc.elpmaxe@ann';
    const action = describeServiceAction(send({ recipient_email: spoof }));
    expect(action.recipients![0]!.address).toBe('evil<U+202E>moc.elpmaxe@ann');
  });

  it('shows control characters and line separators instead of letting them break the line', () => {
    expect(inertRecipient('a@example.com\nBcc: b@example.com')).toBe(
      'a@example.com<U+000A>Bcc: b@example.com'
    );
    expect(inertRecipient('a@example.com\u2028b@x.com\u0085\u200B')).toBe(
      'a@example.com<U+2028>b@x.com<U+0085><U+200B>'
    );
  });

  it('caps an address no real one reaches with "…", and never drops it', () => {
    const long = `${'garden.note.'.repeat(35)}ann@example.com`;
    const [line] = describeServiceAction(send({ recipient_email: long })).recipients!;
    expect(Array.from(line!.address)).toHaveLength(APPROVAL_SERVICE_RECIPIENT_MAX_LENGTH);
    expect(line!.address.endsWith('…')).toBe(true);
  });

  it('counts recipients past the card’s limit instead of cutting them silently', () => {
    const many = Array.from(
      { length: APPROVAL_SERVICE_MAX_RECIPIENTS + 3 },
      (_, i) => `p${i}@x.com`
    );
    const action = describeServiceAction(send({ bcc: many }));
    expect(action.recipients).toHaveLength(APPROVAL_SERVICE_MAX_RECIPIENTS);
    expect(action.recipientsCut).toBe(3);
  });

  it('keeps every recipient through the stored card', () => {
    const action = describeServiceAction(
      send({ recipient_email: 'ann@example.com', cc: ['bo@example.org'], bcc: ['cy@example.net'] })
    );
    const stored = JSON.parse(storableServiceAction(action)!) as ApprovalServiceAction;
    expect(lines(stored)).toHaveLength(3);
    expect(lines(stored)).toEqual(lines(action));
  });

  it('leaves a list that isn’t recipients folding in the glance as before', () => {
    const action = describeServiceAction({
      ...send({}),
      operationSlug: 'GMAIL_ADD_LABEL',
      inputSchema: { type: 'object', properties: { label_names: { type: 'array' } } },
      arguments: { label_names: ['a', 'b', 'c', 'd', 'e'] },
    });
    expect(action.recipients).toBeUndefined();
    expect(action.details[0]!.value).toBe('a, b, c and 2 more');
  });
});

// Review round 1: nothing may make the stored card drop its recipients, or the summary forget them.
describe('recipients survive every place the card goes', () => {
  const RLO = String.fromCodePoint(0x202e);
  const GRIN = String.fromCodePoint(0x1f600);

  it('keeps an address of emoji, which counts double in UTF-16, through the stored card', () => {
    const action = describeServiceAction(send({ cc: [GRIN.repeat(200)] }));
    expect(action.recipients![0]!.address.length).toBeLessThanOrEqual(
      APPROVAL_SERVICE_RECIPIENT_MAX_LENGTH
    );
    const stored = storableServiceAction(action);
    expect(stored).not.toBeNull();
    expect((JSON.parse(stored!) as ApprovalServiceAction).recipients).toHaveLength(1);
  });

  it('makes a raw override inert where the card is stored, whoever built it', () => {
    const action = describeServiceAction(send({ recipient_email: 'ann@example.com' }));
    const forged = { ...action, recipients: [{ label: 'To', address: `evil${RLO}moc.x@ann` }] };
    const stored = JSON.parse(storableServiceAction(forged)!) as ApprovalServiceAction;
    expect(stored.recipients![0]!.address).toBe('evil<U+202E>moc.x@ann');
  });

  it('names every recipient in the summary sentence the audit and notifications read', () => {
    const action = describeServiceAction(
      send({ recipient_email: 'ann@example.com', bcc: ['outsider@example.net'], subject: 'Hi' })
    );
    const summary = describeGatedAttempt(
      { id: 'connectors.execute_write', title: 'Send', tier: 'act', area: null },
      {},
      undefined,
      undefined,
      action
    );
    expect(summary).toContain('ann@example.com');
    expect(summary).toContain('outsider@example.net');
  });

  it('lists a calendar invite’s attendees by their email field', () => {
    const action = describeServiceAction({
      ...send({}),
      operationSlug: 'GOOGLECALENDAR_CREATE_EVENT',
      inputSchema: { type: 'object', properties: { attendees: { type: 'array' } } },
      arguments: {
        attendees: [
          { email: 'ann@example.com', optional: false },
          { email: 'outsider@example.net', optional: true },
        ],
      },
    });
    expect(lines(action)).toEqual([
      'Attendees: ann@example.com',
      'Attendees: outsider@example.net',
    ]);
  });
});

describe('which arguments are recipients', () => {
  it('reads the shared names and words, and never a secret', () => {
    for (const name of ['to', 'toEmail', 'email', 'emails', 'phone', 'phoneNumber', 'cc', 'bcc'])
      expect(isRecipientArgumentName(name), name).toBe(true);
    for (const name of ['recipient_email', 'extra_recipients', 'attendees', 'participants'])
      expect(isRecipientArgumentName(name), name).toBe(true);
    for (const name of ['subject', 'body', 'reply_to_message_id', 'path_to_file', 'email_token'])
      expect(isRecipientArgumentName(name), name).toBe(false);
  });
});
