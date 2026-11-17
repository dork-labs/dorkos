import { ApprovalList } from '@/layers/features/approvals';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';

/** Made-up phone card for reviewing remote confirmation without a real request. */
export function RemoteApprovalShowcase() {
  const approval: PendingApproval = {
    approvalId: '01JZ0000000000000000000088',
    capabilityId: 'marketplace.install',
    capabilityTitle: 'Install a package',
    tier: 'act',
    summary: 'Install @northwind/charts 3.2.0 in Kestrel’s folder.',
    requestedBy: 'Kestrel',
    hasAgentPath: true,
    area: 'packages',
    alwaysOffered: true,
    answerNeedsStepUp: true,
    requestCode: 'K7MR-4XQ9-HT3W',
    answeringFrom: 'Safari on iPhone over Remote Access',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  return (
    <div className="w-full max-w-[390px]">
      <ApprovalList approvals={[approval]} />
    </div>
  );
}
