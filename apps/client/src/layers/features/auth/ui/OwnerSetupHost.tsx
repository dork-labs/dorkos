import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/layers/shared/ui';
import { clearOwnerSetupRequest } from '@/layers/shared/lib';
import { configKeys, useConfig } from '@/layers/entities/config';
import { useOwnerSetupRequest } from '../model/use-auth-signal';
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { OwnerSignInScreen } from './OwnerSignInScreen';

/**
 * App-shell host for the owner-setup flow raised outside `features/auth` — today
 * the tunnel exposure gate (`AUTH_REQUIRED_FOR_EXPOSURE`, task 1.3). Reads the
 * shared owner-setup request signal, walks the user through owner creation (or,
 * when an owner already exists, a sign-in as that owner), then retries the
 * original action via `request.onComplete`. It never turns on "Ask for a
 * password on this computer too": exposure needs only the owner, since other
 * devices always sign in (ADR 261015-125850).
 */
export function OwnerSetupHost() {
  const request = useOwnerSetupRequest();
  const queryClient = useQueryClient();
  const { data: config, refetch: refetchConfig } = useConfig();
  // Set when the create form discovers an owner the config read had not shown.
  const [foundOwnerEmail, setFoundOwnerEmail] = useState<string | null>(null);
  const signInEmail = config?.auth?.ownerEmail ?? foundOwnerEmail;

  const enableAndComplete = useCallback(async () => {
    // The owner now exists, which is all exposure needs: other devices always
    // sign in as it. "Ask for a password on this computer too" stays as the
    // person set it (ADR 261015-125850). Refresh, then retry the action.
    await queryClient.invalidateQueries({ queryKey: configKeys.current() });
    const onComplete = request?.onComplete;
    setFoundOwnerEmail(null);
    clearOwnerSetupRequest();
    onComplete?.();
  }, [queryClient, request]);

  const signInInstead = useCallback(
    async (knownOwnerEmail: string | null) => {
      const { data } = await refetchConfig();
      // Null leaves the create form up, saying an owner exists.
      setFoundOwnerEmail(data?.auth?.ownerEmail ?? knownOwnerEmail);
    },
    [refetchConfig]
  );

  const cancel = useCallback(() => {
    setFoundOwnerEmail(null);
    clearOwnerSetupRequest();
  }, []);

  if (!request) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{signInEmail ? 'Sign in' : 'Create an owner account'}</DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>
        {signInEmail ? (
          <OwnerSignInScreen
            ownerEmail={signInEmail}
            submitLabel="Sign in & continue"
            onVerified={enableAndComplete}
            onCancel={cancel}
          />
        ) : (
          <OwnerSetupScreen
            submitLabel="Create account & continue"
            onCreated={enableAndComplete}
            onOwnerExists={signInInstead}
            onCancel={cancel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
