import type { ApprovalServiceAction, PendingApproval } from '@dorkos/shared/approval-schemas';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ApprovalList } from '@/layers/features/approvals';

/** Frozen at module load, so countdowns don't shift on re-render. */
const LOADED_AT = Date.now();

/** A Gmail send's card before its recipients. Made-up addresses only. */
const GMAIL_SEND: ApprovalServiceAction = {
  serviceId: 'gmail',
  serviceName: 'Gmail',
  accountLabel: 'Work (work@acme.com)',
  actionName: 'Send email',
  details: [
    { label: 'Subject', value: 'Spring planting day' },
    { label: 'Body', value: 'See you all at the garden on Saturday.' },
  ],
};

/** A send's approval, varying only its recipients and whether it can be allowed. */
function sendApproval(
  approvalId: string,
  action: Partial<ApprovalServiceAction>,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    approvalId,
    capabilityId: 'connectors.execute_write',
    capabilityTitle: 'Act in a connected app',
    tier: 'act',
    summary: '"DorkBot" wants to run "Send email" in Gmail on "Work (work@acme.com)"',
    requestedBy: 'DorkBot',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    answerNeedsStepUp: false,
    requestedAt: new Date(LOADED_AT).toISOString(),
    expiresAt: new Date(LOADED_AT + 105 * 60_000).toISOString(),
    serviceAction: { ...GMAIL_SEND, ...action },
    ...overrides,
  };
}

/**
 * A send's recipients on its approval card (DOR-4592): every address on its own
 * line above the details, never "and N more", and decline-only when one can't
 * be shown. The addresses arrive already inert from the server, so a hidden
 * character shows as its visible `<U+…>` code.
 */
export function SendRecipientsShowcases() {
  return (
    <PlaygroundSection
      title="Send recipients"
      description="Who a send goes to, one line each, above the rest of the card. A send that hides a recipient can only be declined."
    >
      <ShowcaseLabel>Three recipients, one with a hidden character</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sendApproval('01JZ0000000000000000000091', {
              recipients: [
                { label: 'Recipient email', address: 'board@acme.com' },
                { label: 'CC', address: 'finance@acme.com' },
                { label: 'CC', address: 'evil<U+202E>moc.emca@draob' },
              ],
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Forty recipients scroll inside their box</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sendApproval('01JZ0000000000000000000092', {
              recipients: Array.from({ length: 40 }, (_, i) => ({
                label: i === 0 ? 'Recipient email' : 'BCC',
                address: `member${i + 1}@garden-club.example`,
              })),
              everything: [
                { label: 'Subject', value: 'Spring planting day', depth: 0 },
                { label: 'Body', value: 'See you all at the garden on Saturday.', depth: 0 },
              ],
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Past the card’s limit, a send can only be declined</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sendApproval(
              '01JZ0000000000000000000093',
              {
                recipients: Array.from({ length: 6 }, (_, i) => ({
                  label: 'BCC',
                  address: `reader${i + 1}@newsletter.example`,
                })),
                recipientsCut: 3,
              },
              { cannotAllow: true }
            ),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>An address too long to show, so it can only be declined</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sendApproval(
              '01JZ0000000000000000000094',
              {
                recipients: [
                  { label: 'Recipient email', address: 'board@acme.com' },
                  { label: 'CC', address: `${'garden.note.'.repeat(25)}ann@exampl…` },
                ],
                recipientsShortened: 1,
              },
              { cannotAllow: true }
            ),
          ]}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
