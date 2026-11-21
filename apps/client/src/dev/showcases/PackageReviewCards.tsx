import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { ApprovalList } from '@/layers/features/approvals';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  PACKAGE_REVIEW_DETAIL,
  PACKAGE_REVIEW_SUMMARY,
  INSTALL_SUMMARY,
} from './marketplace-summary-samples';

/** The two package review cards, using the same fixture clock as their parent. */
export function PackageReviewCards({
  sample,
}: {
  sample: (overrides: Partial<PendingApproval>) => PendingApproval;
}) {
  return (
    <>
      <ShowcaseLabel>Package review: first card, then the content card</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sample({
              approvalId: '01JZ0000000000000000000081',
              capabilityId: 'marketplace.install',
              capabilityTitle: 'Install a marketplace package',
              tier: 'act',
              requestedBy: 'Scout',
              summary:
                'This request followed words from outside your team.\nScout wants to install "sample-board".',
              detail: 'DorkOS will show you what’s in it next.',
            }),
            sample({
              approvalId: '01JZ0000000000000000000082',
              capabilityId: 'marketplace.install',
              capabilityTitle: 'Install a marketplace package',
              tier: 'act',
              requestedBy: 'Scout',
              summary:
                'This request followed words from outside your team.\nInstall "sample-board" from "sample-market".',
              detail: PACKAGE_REVIEW_DETAIL,
              marketplaceSummary: PACKAGE_REVIEW_SUMMARY,
            }),
          ]}
        />
      </ShowcaseDemo>
    </>
  );
}

/** The summary path of the same package review, with full details behind it. */
export function LargePackageReviewCard({
  sample,
}: {
  sample: (overrides: Partial<PendingApproval>) => PendingApproval;
}) {
  return (
    <>
      <ShowcaseLabel>A large Marketplace install, with an in-process extension</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ApprovalList
          approvals={[
            sample({
              approvalId: '01JZ0000000000000000000072',
              capabilityId: 'marketplace.install',
              capabilityTitle: 'Install a marketplace package',
              summary:
                'This request followed words from outside your team.\nInstall "sample-flow" from "sample-market"',
              detail: 'The rows as text.',
              marketplaceSummary: INSTALL_SUMMARY,
            }),
          ]}
        />
      </ShowcaseDemo>
    </>
  );
}
