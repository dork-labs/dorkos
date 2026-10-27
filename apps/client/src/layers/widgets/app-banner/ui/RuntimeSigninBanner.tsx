import { LogIn } from 'lucide-react';
import { signinTarget } from '@dorkos/shared/notification-schemas';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';

import { useLocalCaller } from '@/layers/entities/config';
import { useCloudStatus } from '@/layers/features/cloud-link';
import { creditsVerb, useCloudPlan } from '@/layers/features/cloud-plan';
import {
  AccountSignin,
  creditsOfferFor,
  KeepItLocalNote,
  selectRuntimeSignIn,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import {
  Banner,
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import {
  useClaudeAccounts,
  useCloudCredits,
  useCreditsOfferSlot,
  useSettingsDeepLink,
  type CreditsOfferSlot,
} from '@/layers/shared/model';

/** The Settings tab where signing in again actually happens. */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

/**
 * How many runtimes are named before the rest become a count.
 *
 * Three, which is every runtime DorkOS ships today — so in practice the row
 * always names them all, and the truncation is a guard against a fourth runtime
 * turning this line into a wall of text rather than a case anybody hits.
 */
const NAMED_LIMIT = 3;

export interface RuntimeSigninBannerProps {
  /** Account-scoped subjects (or legacy runtime types) still needing sign-in. */
  runtimes: string[];
}

/** Name the affected accounts and offer a sign-in pinned to each one. */
export function RuntimeSigninBanner({ runtimes }: RuntimeSigninBannerProps) {
  const { open: openSettings } = useSettingsDeepLink();
  const renderCreditsOffer = useCreditsOfferSlot();
  const { nameFor } = useClaudeAccounts();
  if (runtimes.length === 0) return null;

  const targets = runtimes.map(signinTarget);
  const named = targets
    .slice(0, NAMED_LIMIT)
    .map((target) =>
      target.accountRoot ? nameFor(target.accountRoot) : runtimeDisplayName(target.runtime)
    );
  const remaining = runtimes.length - named.length;

  const subject = `${joinNames(named)}${remaining > 0 ? ` and ${remaining} more` : ''}`;
  const singleAccount =
    targets.length === 1 && targets[0].runtime === 'claude-code'
      ? targets[0].accountRoot
      : undefined;

  return (
    <Banner
      variant="critical"
      icon={LogIn}
      actions={
        <>
          {targets.length === 1 && renderCreditsOffer && (
            <CreditsLeadAction
              runtimes={targets.map((target) => target.runtime)}
              renderCreditsOffer={renderCreditsOffer}
            />
          )}
          {singleAccount ? (
            <AccountSignin
              accountRoot={singleAccount}
              name={nameFor(singleAccount)}
              state="signed-out"
              showAccountName
              hideStatus
            />
          ) : (
            <Button variant="outline" size="sm" onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)}>
              Review sign-ins
            </Button>
          )}
        </>
      }
    >
      <span className="font-medium">{subject}</span> {targets.length === 1 ? 'is' : 'are'} signed
      out. {targets.length === 1 ? 'Its' : 'Their'} agents and tasks wait until you sign in.
    </Banner>
  );
}

/**
 * "Use DorkOS credits", first in the row, for the first named runtime with no
 * sign-in at all that credits reach — or nothing. Its own component so the
 * reads it needs run only where the app shell supplies the offer.
 */
function CreditsLeadAction({
  runtimes,
  renderCreditsOffer,
}: {
  runtimes: string[];
  renderCreditsOffer: CreditsOfferSlot;
}) {
  const requirements = useRuntimeRequirements();
  const { data: credits } = useCloudCredits();
  const remote = !useLocalCaller();
  // The trigger says what the offer inside it says ("Try…", "Buy…", "Use…").
  const linked = useCloudStatus().data?.linked === true;
  const verb = creditsVerb(linked, useCloudPlan({ enabled: linked }).data);
  const creditsFor = runtimes.find(
    (type) =>
      creditsOfferFor(selectRuntimeSignIn(requirements.data, type), credits, type) === 'lead'
  );
  if (!creditsFor) return null;
  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>
        <Button size="sm" data-testid="signin-banner-credits" disabled={verb === null}>
          {verb === null ? 'DorkOS credits' : `${verb} DorkOS credits`}
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent align="end" className="w-80 p-4">
        <ResponsivePopoverTitle>
          Run {runtimeDisplayName(creditsFor)} on DorkOS credits
        </ResponsivePopoverTitle>
        <div className="space-y-3">
          {renderCreditsOffer({
            runtime: creditsFor,
            origin: `signin-banner:${creditsFor}`,
            fullWidth: true,
          })}
          <KeepItLocalNote remote={remote} />
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}

/** Join names the way a person says them aloud: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
