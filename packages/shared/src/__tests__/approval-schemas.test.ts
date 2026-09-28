import { describe, expect, it } from 'vitest';
import { approvalHeading, ApprovalServiceActionSchema } from '../approval-schemas.js';

const GMAIL_DELETE = {
  serviceId: 'gmail',
  serviceName: 'Gmail',
  accountLabel: 'work@acme.com',
  actionName: 'Delete message',
  details: [{ label: 'Message ID', value: '18c2f0a9d1' }],
};

describe('approvalHeading', () => {
  it('names a connected-app action by what it does', () => {
    expect(approvalHeading({ capabilityTitle: 'Generic title', serviceAction: GMAIL_DELETE })).toBe(
      'Delete message in Gmail'
    );
  });

  it('falls back to the action title for every other approval', () => {
    expect(approvalHeading({ capabilityTitle: 'Uninstall a package' })).toBe('Uninstall a package');
  });
});

describe('ApprovalServiceActionSchema', () => {
  it('refuses fields it does not declare', () => {
    expect(ApprovalServiceActionSchema.safeParse({ ...GMAIL_DELETE, raw: '{}' }).success).toBe(
      false
    );
  });

  it('refuses a value longer than the card shows', () => {
    const long = { ...GMAIL_DELETE, details: [{ label: 'Body', value: 'x'.repeat(121) }] };
    expect(ApprovalServiceActionSchema.safeParse(long).success).toBe(false);
  });
});
