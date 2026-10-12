/**
 * What the first run borrows from other features, composed here because the
 * app shell may import any layer and the onboarding feature may not use a
 * sibling feature's hooks (spec `one-minute-onboarding` §2).
 *
 * - The account link: the one link flow (`features/cloud-link`) and the page
 *   that saves a card (`features/cloud-plan`), lent to the screens as one
 *   object.
 * - The AI apps' connect flows and the DorkOS runtime's model form
 *   (`features/runtime-connect`).
 *
 * @module app/first-run-slots
 */
import type { ReactNode } from 'react';
import { useCloudLink } from '@/layers/features/cloud-link';
import { useOpenBillingPage } from '@/layers/features/cloud-plan';
import type { FirstRunAccountLink, FirstRunSlots } from '@/layers/features/onboarding';
import { DoeInferenceForm, renderRuntimeConnect } from '@/layers/features/runtime-connect';

/** The surface name the first run's link codes carry. */
const FIRST_RUN_ORIGIN = 'onboarding';

/** Lend the screens the account link, read live. */
function AccountLinkBridge({ render }: { render: (link: FirstRunAccountLink) => ReactNode }) {
  const link = useCloudLink();
  const billing = useOpenBillingPage();
  const { view } = link;
  const notice = billing.notice;

  return render({
    state: view.kind,
    pending:
      view.kind === 'pending'
        ? {
            userCode: view.userCode,
            verificationUri: view.verificationUri,
            ...(view.verificationUriComplete
              ? { verificationUriComplete: view.verificationUriComplete }
              : {}),
          }
        : null,
    starting: link.starting,
    startError: link.startError,
    start: () => link.start({ origin: FIRST_RUN_ORIGIN }),
    cancel: link.cancel,
    // The account's billing page is where a card is saved for later charges.
    openBilling: () => billing.open({ page: 'portal' }),
    billingPending: billing.pending !== null,
    billingNotice:
      notice === null
        ? null
        : 'message' in notice
          ? notice.message
          : (notice.problem.detail ?? notice.problem.title),
  });
}

/** Everything the app shell lends the first run. */
export const FIRST_RUN_SLOTS: FirstRunSlots = {
  renderAccountLink: (render) => <AccountLinkBridge render={render} />,
  renderRuntimeConnect,
  renderOtherService: ({ onSave }) => <DoeInferenceForm onSave={onSave} />,
};
