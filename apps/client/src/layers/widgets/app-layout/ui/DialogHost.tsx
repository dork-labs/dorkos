import { useCallback, useSyncExternalStore } from 'react';
import {
  useAppStore,
  useSlotContributions,
  useSettingsDeepLink,
  useTasksDeepLink,
  useProfileDeepLink,
  type DialogContribution,
  type DialogOpenState,
} from '@/layers/shared/model';

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
 * All deep-link hooks are called unconditionally on every render to
 * satisfy React's rules-of-hooks; the `switch` only chooses which result to
 * return. For contributions without a `urlParam` (e.g., `directory-picker`,
 * `server-restart-overlay`), returns an inert `{ isOpen: false, close: noop }`.
 */
function useDialogUrlSignal(urlParam: DialogContribution['urlParam']): {
  isOpen: boolean;
  close: () => void;
} {
  const settings = useSettingsDeepLink();
  const tasks = useTasksDeepLink();
  const profile = useProfileDeepLink();

  switch (urlParam) {
    case 'settings':
      return { isOpen: settings.isOpen, close: settings.close };
    case 'tasks':
      return { isOpen: tasks.isOpen, close: tasks.close };
    case 'profile':
      return { isOpen: profile.isOpen, close: profile.close };
    default:
      return { isOpen: false, close: () => {} };
  }
}

/**
 * Renders a single registry-driven dialog by reading its open state from a
 * dual signal — the store flag (via `openStateKey`) OR the URL signal (via
 * `urlParam`). Closing clears both so deep-linked dialogs don't stick around.
 */
function StoreDialog({
  contribution,
  openStateKey,
}: {
  contribution: DialogContribution;
  openStateKey: string;
}) {
  const storeOpen = useAppStore((s) => s[openStateKey as keyof typeof s] as boolean);
  const setStoreOpen = useAppStore(
    (s) => s[toSetterKey(openStateKey) as keyof typeof s] as (open: boolean) => void
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
 * Renders a dialog that keeps its own open flag (an extension dialog). It is
 * mounted only while open: an extension cannot be trusted to honour `open`, and
 * one that ignored it would otherwise sit on screen for good.
 */
function OwnStateDialog({
  contribution,
  openState,
}: {
  contribution: DialogContribution;
  openState: DialogOpenState;
}) {
  const open = useSyncExternalStore(openState.subscribe, openState.getSnapshot);
  const Component = contribution.component;
  if (!open) return null;
  return <Component open onOpenChange={openState.set} />;
}

/** Renders one registry dialog from whichever open state it keeps. */
function RegistryDialog({ contribution }: { contribution: DialogContribution }) {
  if (contribution.openState) {
    return <OwnStateDialog contribution={contribution} openState={contribution.openState} />;
  }
  return <StoreDialog contribution={contribution} openStateKey={contribution.openStateKey} />;
}

/**
 * Root-level dialog host that renders all application dialogs outside
 * the SidebarProvider. This ensures dialogs survive sidebar open/close
 * cycles and mobile Sheet unmounts.
 *
 * Dialogs are rendered from the extension registry's `dialog` slot. The
 * first-run onboarding overlay is owned by the app shell, not this host.
 */
export function DialogHost() {
  const dialogContributions = useSlotContributions('dialog');

  return (
    <>
      {dialogContributions.map((contribution) => (
        <RegistryDialog key={contribution.id} contribution={contribution} />
      ))}
    </>
  );
}
