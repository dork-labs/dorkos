/**
 * The core prompt a mini app's first forward to an agent raises (DOR-3325).
 * Mounted once by the app shell, outside every extension's DOM; the mini app
 * can ask for it but never draws it. Allow lets DorkOS send the comment it
 * kept; Not now sends nothing.
 *
 * @module features/extensions/ui/ForwardConsentHost
 */
import { useSyncExternalStore } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui';
import {
  answerForwardConsent,
  currentForwardConsent,
  subscribeForwardConsent,
} from '../model/forward-consent';

/** The first-use prompt for `api.forward`. Draws nothing while nobody asks. */
export function ForwardConsentHost() {
  const ask = useSyncExternalStore(subscribeForwardConsent, currentForwardConsent);
  return (
    <AlertDialog
      open={ask !== undefined}
      onOpenChange={(open) => {
        if (!open && ask) answerForwardConsent(ask, false);
      }}
    >
      {ask && (
        <AlertDialogContent data-testid="forward-consent">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send {ask.appName} comments to {ask.agentName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Registered as @{ask.agentHandle}. Your comments reach this agent as your own words.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => answerForwardConsent(ask, false)}>
              Not now
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => answerForwardConsent(ask, true)}>
              Allow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
