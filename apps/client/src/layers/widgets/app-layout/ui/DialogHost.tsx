import { useCallback } from 'react';
import { useAppStore, useSlotContributions, type DialogContribution } from '@/layers/shared/model';
import { OnboardingFlow } from '@/layers/features/onboarding';

/**
 * Derive the setter name from an `openStateKey` by capitalizing its first letter
 * and prepending `set` (e.g., `'settingsOpen'` -> `'setSettingsOpen'`).
 */
function toSetterKey(openStateKey: string): string {
  return `set${openStateKey.charAt(0).toUpperCase()}${openStateKey.slice(1)}`;
}

/**
 * Renders a single registry-driven dialog by reading its open state and setter
 * from the app store dynamically via the contribution's `openStateKey`.
 */
function RegistryDialog({ contribution }: { contribution: DialogContribution }) {
  const openStateKey = contribution.openStateKey;
  const setterKey = toSetterKey(openStateKey);

  const open = useAppStore((state) => state[openStateKey as keyof typeof state] as boolean);
  const setter = useAppStore(
    (state) => state[setterKey as keyof typeof state] as (open: boolean) => void
  );

  const onOpenChange = useCallback((value: boolean) => setter(value), [setter]);

  const Component = contribution.component;
  return <Component open={open} onOpenChange={onOpenChange} />;
}

/**
 * Root-level dialog host that renders all application dialogs outside
 * the SidebarProvider. This ensures dialogs survive sidebar open/close
 * cycles and mobile Sheet unmounts.
 *
 * Dialogs are rendered from the extension registry's `dialog` slot.
 * OnboardingFlow is hardcoded because it is not a standard open/close dialog.
 */
export function DialogHost() {
  const dialogContributions = useSlotContributions('dialog');
  const onboardingStep = useAppStore((s) => s.onboardingStep);
  const setOnboardingStep = useAppStore((s) => s.setOnboardingStep);

  return (
    <>
      {dialogContributions.map((contribution) => (
        <RegistryDialog key={contribution.id} contribution={contribution} />
      ))}
      {onboardingStep !== null && (
        <div className="bg-background fixed inset-0 z-50">
          <OnboardingFlow initialStep={onboardingStep} onComplete={() => setOnboardingStep(null)} />
        </div>
      )}
    </>
  );
}
