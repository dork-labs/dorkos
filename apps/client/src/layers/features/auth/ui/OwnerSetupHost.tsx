import { useCallback } from 'react';
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
import { configKeys } from '@/layers/entities/config';
import { useOwnerSetupRequest } from '../model/use-auth-signal';
import { OwnerSetupScreen } from './OwnerSetupScreen';

/**
 * App-shell host for the owner-setup flow raised outside `features/auth` — today
 * the tunnel exposure gate (`AUTH_REQUIRED_FOR_EXPOSURE`, task 1.3). Reads the
 * shared owner-setup request signal, walks the user through owner creation, flips
 * `auth.enabled` on, then retries the original action via `request.onComplete`.
 */
export function OwnerSetupHost() {
  const request = useOwnerSetupRequest();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const enableAndComplete = useCallback(async () => {
    // Owner now exists (or already existed): require login, then retry the action.
    await transport.updateConfig({ auth: { enabled: true } });
    await queryClient.invalidateQueries({ queryKey: configKeys.current() });
    const onComplete = request?.onComplete;
    clearOwnerSetupRequest();
    onComplete?.();
  }, [transport, queryClient, request]);

  if (!request) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && clearOwnerSetupRequest()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an owner account</DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>
        <OwnerSetupScreen
          submitLabel="Create account & continue"
          onCreated={enableAndComplete}
          onOwnerExists={enableAndComplete}
          onCancel={clearOwnerSetupRequest}
        />
      </DialogContent>
    </Dialog>
  );
}
