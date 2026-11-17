/**
 * A send's approval card names who the mail goes to (DOR-4587, Security): the secret sweeps every
 * card gets must leave email addresses in To, Cc and Bcc as they are, or a card meant to stop a
 * swapped address would hide it.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalServiceAction } from '@dorkos/shared/approval-schemas';
import { storableServiceAction } from '../../../core/approvals/approval-storable.js';
import { describeServiceAction } from '../approval-service-action.js';

const ADDRESSES = ['ann@example.com', 'bo.lee@example.org', 'cy+news@example.net'];

describe("a Gmail send's approval card", () => {
  it('keeps every recipient address through the stored card', () => {
    const action = describeServiceAction({
      toolkit: 'gmail',
      connectionLabel: 'Work mail',
      identityHint: 'owner@example.com',
      operationSlug: 'GMAIL_SEND_EMAIL',
      inputSchema: {
        type: 'object',
        properties: {
          recipient_email: { type: 'string' },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
      },
      arguments: {
        recipient_email: ADDRESSES[0],
        cc: [ADDRESSES[1]],
        bcc: [ADDRESSES[2]],
        subject: 'Garden note',
        body: 'The made-up garden note.',
      },
    });
    const stored = JSON.parse(storableServiceAction(action)!) as ApprovalServiceAction;
    const shown = JSON.stringify([stored.details, stored.everything ?? []]);
    for (const address of ADDRESSES) expect(shown, address).toContain(address);
    expect(shown).toContain('The made-up garden note.');
  });
});
