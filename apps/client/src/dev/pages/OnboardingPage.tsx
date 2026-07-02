import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ONBOARDING_SECTIONS } from '../playground-registry';
import { OnboardingFlowShowcases } from '../showcases/OnboardingFlowShowcases';
import { RuntimeSetupShowcases } from '../showcases/RuntimeSetupShowcases';

/** Dedicated onboarding flow playground page with full flow and individual step showcases. */
export function OnboardingPage() {
  return (
    <PlaygroundPageLayout
      title="Onboarding"
      description="Full interactive onboarding flow, individual step previews, and supporting components."
      sections={ONBOARDING_SECTIONS}
    >
      <OnboardingFlowShowcases />
      <RuntimeSetupShowcases />
    </PlaygroundPageLayout>
  );
}
