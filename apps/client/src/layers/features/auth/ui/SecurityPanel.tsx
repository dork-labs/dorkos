import { useState } from 'react';
import { LogOut } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldCard,
  FieldCardContent,
  SettingRow,
  Switch,
} from '@/layers/shared/ui';
import { useConfig, useIsHub, useUpdateConfig } from '@/layers/entities/config';
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { OwnerSignInScreen } from './OwnerSignInScreen';
import { ApiKeysSection } from './ApiKeysSection';
import { useCurrentUser, useSignOut } from '../model/use-auth-session';

/** Which step turning login on needs: create the owner, or sign in as the one that exists. */
type EnableStep = { kind: 'create' } | { kind: 'sign-in'; email: string };

/**
 * Settings › Login & security — the single entry point to local
 * login. Other devices always need a password (ADR 261015-125850); the one
 * switch here is "Ask for a password on this computer too" (`auth.enabled`).
 * Progressive disclosure: signed out, only the switch shows (no sign-out, no
 * API keys). Turning it on creates the owner account when there is none, or
 * asks the existing owner to sign in when there is one, and flips
 * `auth.enabled` only after that succeeds. An install
 * with an owner used to get the create form, which can only fail there
 * (DOR-2964).
 *
 * Registered as the Settings dialog's `security` tab directly (DOR-2628): the
 * Access tab that used to wrap it beside the DorkOS account is gone, and the
 * dialog draws the panel's heading.
 */
export function SecurityPanel() {
  const isHub = useIsHub();
  const { data: config, refetch: refetchConfig } = useConfig();
  const updateConfig = useUpdateConfig();
  const currentUser = useCurrentUser();
  const signOut = useSignOut();

  const authEnabled = config?.auth?.enabled ?? false;
  const ownerEmail = config?.auth?.ownerEmail ?? null;
  const [step, setStep] = useState<EnableStep | null>(null);

  function handleToggle(next: boolean) {
    if (next) {
      // The flag flips only after the owner is created or has signed in.
      setStep(ownerEmail ? { kind: 'sign-in', email: ownerEmail } : { kind: 'create' });
    } else {
      updateConfig.mutate({ auth: { enabled: false } });
    }
  }

  async function enableLogin() {
    await updateConfig.mutateAsync({ auth: { enabled: true } });
    setStep(null);
  }

  // The create form found an owner after all (a stale config read, or another
  // window made one). Never turn login on from here: ask that owner to sign in.
  async function signInInstead(knownOwnerEmail: string | null) {
    const { data } = await refetchConfig();
    const email = data?.auth?.ownerEmail ?? knownOwnerEmail;
    // No email to sign in as: the form keeps saying an owner exists.
    if (email) setStep({ kind: 'sign-in', email });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {/* No heading here: the Settings dialog draws the panel's own
            ("Login & security"). This is its explainer. */}
        <p className="text-muted-foreground text-sm">
          {isHub
            ? 'You sign in here with your DorkOS account.'
            : 'Other devices always need your password. This computer can ask for it too.'}
        </p>
      </div>

      <FieldCard>
        <FieldCardContent>
          {/* A hub is never "this computer", and always asks. */}
          {!isHub && (
            <SettingRow
              label="Ask for a password on this computer too"
              description={
                authEnabled
                  ? 'This computer asks for your password before DorkOS opens.'
                  : 'This computer opens DorkOS without a password.'
              }
            >
              <Switch
                checked={authEnabled}
                onCheckedChange={handleToggle}
                aria-label="Ask for a password on this computer too"
              />
            </SettingRow>
          )}

          {/* Signed in from any device, not only when this computer asks. */}
          {currentUser && (
            <SettingRow label="Signed in" description={currentUser?.email ?? 'Owner account'}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => signOut.run()}
                disabled={signOut.isPending}
              >
                <LogOut className="mr-1.5 size-3.5" />
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </Button>
            </SettingRow>
          )}
        </FieldCardContent>
      </FieldCard>

      {/* Keys outlive the login flag, so this card must too (DOR-1885). Turning
          "Ask for a password on this computer too" off deletes no key, ends no session and stops nothing
          working — `/api/config` still reports `authSource: 'user-keys'` and
          `/mcp` still accepts every one of them. Gating the card on
          `authEnabled` therefore hid live credentials the owner could neither
          see nor revoke. It is gated on a SESSION instead, which is exactly when
          `/api/auth/api-key/*` answers: signed out, those endpoints 401, and a
          card that can only fail is worse than no card. */}
      {(authEnabled || currentUser) && (
        <FieldCard>
          <FieldCardContent>
            <ApiKeysSection loginRequired={authEnabled} />
          </FieldCardContent>
        </FieldCard>
      )}

      <Dialog open={step !== null} onOpenChange={(open) => !open && setStep(null)}>
        <DialogContent>
          {step?.kind === 'sign-in' ? (
            <>
              <DialogHeader>
                <DialogTitle>Ask for a password here too</DialogTitle>
                <DialogDescription>This turns on once your password checks out.</DialogDescription>
              </DialogHeader>
              <OwnerSignInScreen
                ownerEmail={step.email}
                onVerified={enableLogin}
                onCancel={() => setStep(null)}
              />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create an owner account</DialogTitle>
                <DialogDescription>This becomes your sign-in on every device.</DialogDescription>
              </DialogHeader>
              <OwnerSetupScreen
                submitLabel="Create account & ask here too"
                onCreated={enableLogin}
                onOwnerExists={signInInstead}
                onCancel={() => setStep(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
