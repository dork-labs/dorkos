import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { clearOwnerSetupRequest } from '@/layers/shared/lib';
import { configKeys, useConfig } from '@/layers/entities/config';
import { useOwnerSetupRequest } from '../model/use-auth-signal';
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { OwnerSignInScreen } from './OwnerSignInScreen';

/**
 * App-shell host for the owner-setup flow raised outside `features/auth` — today
 * the tunnel exposure gate (`AUTH_REQUIRED_FOR_EXPOSURE`, task 1.3). Reads the
 * shared owner-setup request signal, walks the user through owner creation (or,
 * when an owner already exists, a sign-in as that owner), flips `auth.enabled`
 * on, then retries the original action via `request.onComplete`. Login never
 * turns on for an existing owner without a verified sign-in (DOR-2964).
 */
export function OwnerSetupHost() {
  const request = useOwnerSetupRequest();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: config, refetch: refetchConfig } = useConfig();
  // Set when the create form discovers an owner the config read had not shown.
  const [foundOwnerEmail, setFoundOwnerEmail] = useState<string | null>(null);
  const signInEmail = config?.auth?.ownerEmail ?? foundOwnerEmail;

  const enableAndComplete = useCallback(async () => {
    // Owner now exists (or already existed): require login, then retry the action.
    await transport.updateConfig({ auth: { enabled: true } });
    await queryClient.invalidateQueries({ queryKey: configKeys.current() });
    const onComplete = request?.onComplete;
    setFoundOwnerEmail(null);
    clearOwnerSetupRequest();
    onComplete?.();
  }, [transport, queryClient, request]);

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
          <DialogTitle>{signInEmail ? 'Turn on login' : 'Create an owner account'}</DialogTitle>
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
