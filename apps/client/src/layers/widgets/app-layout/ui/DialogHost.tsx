import { useCallback } from 'react';
import {
  useAppStore,
  useSlotContributions,
  useSettingsDeepLink,
  useAgentDialogDeepLink,
  useTasksDeepLink,
  useRelayDeepLink,
  useMeshDeepLink,
  type DialogContribution,
} from '@/layers/shared/model';
import { OnboardingFlow } from '@/layers/features/onboarding';

/**
 * Derive the setter name from an `openStateKey` by capitalizing its first letter
 * and prepending `set` (e.g., `'settingsOpen'` -> `'setSettingsOpen'`).
 */
function toSetterKey(openStateKey: string): string {
  return `set${openStateKey.charAt(0).toUpperCase()}${openStateKey.slice(1)}`;
}

/**
 * Read the URL open signal for a dialog by its `urlParam` field.
 *
 * All five deep-link hooks are called unconditionally on every render to
 * satisfy React's rules-of-hooks; the `switch` only chooses which result to
 * return. For contributions without a `urlParam` (e.g., `directory-picker`,
 * `server-restart-overlay`), returns an inert `{ isOpen: false, close: noop }`.
 */
function useDialogUrlSignal(urlParam: DialogContribution['urlParam']): {
  isOpen: boolean;
  close: () => void;
} {
  const settings = useSettingsDeepLink();
  const agent = useAgentDialogDeepLink();
  const tasks = useTasksDeepLink();
  const relay = useRelayDeepLink();
  const mesh = useMeshDeepLink();

  switch (urlParam) {
    case 'settings':
      return { isOpen: settings.isOpen, close: settings.close };
    case 'agent':
      return { isOpen: agent.isOpen, close: agent.close };
    case 'tasks':
      return { isOpen: tasks.isOpen, close: tasks.close };
    case 'relay':
      return { isOpen: relay.isOpen, close: relay.close };
    case 'mesh':
      return { isOpen: mesh.isOpen, close: mesh.close };
    default:
      return { isOpen: false, close: () => {} };
  }
}

/**
 * Renders a single registry-driven dialog by reading its open state from a
 * dual signal — the store flag (via `openStateKey`) OR the URL signal (via
 * `urlParam`). Closing clears both so deep-linked dialogs don't stick around.
 */
function RegistryDialog({ contribution }: { contribution: DialogContribution }) {
  const storeOpen = useAppStore((s) => s[contribution.openStateKey as keyof typeof s] as boolean);
  const setStoreOpen = useAppStore(
    (s) => s[toSetterKey(contribution.openStateKey) as keyof typeof s] as (open: boolean) => void
  );

  const urlSignal = useDialogUrlSignal(contribution.urlParam);
  // Capture primitive + stable callback reference separately so `onOpenChange`
  // below isn't invalidated on every render. `useDialogUrlSignal` returns a
  // fresh object literal each render (the switch picks a new `{isOpen, close}`),
  // but the underlying `close` callbacks come from `useCallback` inside each
  // deep-link hook and are stable across renders.
  const urlIsOpen = urlSignal.isOpen;
  const urlClose = urlSignal.close;

  const open = storeOpen || urlIsOpen;

  const onOpenChange = useCallback(
    (value: boolean) => {
      setStoreOpen(value);
      if (!value && urlIsOpen) urlClose();
    },
    [setStoreOpen, urlIsOpen, urlClose]
  );

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
