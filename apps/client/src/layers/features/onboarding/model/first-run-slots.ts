/**
 * What the first run borrows from other features, as render slots the app
 * shell fills (spec `one-minute-onboarding` §2).
 *
 * The first run needs the one account-link flow (`features/cloud-link`), the
 * billing page (`features/cloud-plan`), the AI apps' connect flows and the
 * DorkOS runtime's own model form (`features/runtime-connect`). A feature's
 * model may not import another feature's hooks, so the app shell, which may
 * import any layer, hands each one down as a slot. With no slot (a unit test,
 * the Dev Playground) the screen shows what it can without it.
 *
 * @module features/onboarding/model/first-run-slots
 */
import type { ReactNode } from 'react';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { RuntimeConnectSlot } from '@/layers/entities/runtime';

/** The code waiting for approval on dorkos.ai, and the page that approves it. */
export interface FirstRunPendingCode {
  /** The code, as the approval page shows it. */
  userCode: string;
  /** The approval page. */
  verificationUri: string;
  /** The approval page with the code filled in, when the service sent one. */
  verificationUriComplete?: string;
}

/** The one account-link flow, as the Connecting screen reads and drives it. */
export interface FirstRunAccountLink {
  /** Where the link stands. `linked` covers a computer that was linked already. */
  state: 'loading' | 'idle' | 'pending' | 'linked' | 'expired' | 'denied' | 'revoked';
  /** The code waiting for approval, while `state` is `pending`. */
  pending: FirstRunPendingCode | null;
  /** True while a code is being asked for. */
  starting: boolean;
  /** Why the last start failed, in one sentence, or `null`. */
  startError: string | null;
  /** Ask for a code. Resolves with it, or `null` when none came. */
  start: () => Promise<string | null>;
  /** Stop waiting and drop the code. */
  cancel: () => Promise<void>;
  /** Open the page where the account saves a card. Call it from the click. */
  openBilling: () => void;
  /** True while the billing page's address is being fetched. */
  billingPending: boolean;
  /** Why the billing page did not open, or `null`. */
  billingNotice: string | null;
}

/**
 * Draws the first run with the account link in hand. A render function that
 * takes a render function, so the screens stay in this feature and the slot
 * only lends them the link.
 */
export type FirstRunAccountLinkSlot = (
  render: (link: FirstRunAccountLink) => ReactNode
) => ReactNode;

/** What the Own AI list's "Other service" row saves. */
export interface OtherServiceSaveProps {
  /**
   * Save the service as typed in. Rejects with the sentence to show when it
   * was refused.
   */
  onSave: (inference: DoeInferenceConfig, apiKey: string | null) => Promise<void>;
}

/** Draws the "Other service" form: endpoint, format, model and key. */
export type OtherServiceSlot = (props: OtherServiceSaveProps) => ReactNode;

/** Everything the app shell lends the first run. Every slot is optional. */
export interface FirstRunSlots {
  /** The account link, for Continue with DorkOS. */
  renderAccountLink?: FirstRunAccountLinkSlot;
  /** The AI apps' connect flows, for "An AI app you sign in to". */
  renderRuntimeConnect?: RuntimeConnectSlot;
  /** The DorkOS runtime's model form, for "Other service". */
  renderOtherService?: OtherServiceSlot;
}
