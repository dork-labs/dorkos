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
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { AutonomyAcknowledgementRow } from '@/layers/features/approvals';
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { ApiKeysSection } from './ApiKeysSection';
import { useCurrentUser, useSignOut } from '../model/use-auth-session';

/**
 * Settings › Login & security — the single entry point to local
 * login. Progressive disclosure: when login is off, only the "Require login"
 * toggle shows (no user, no sign-out, no API keys). Enabling it walks the user
 * through owner-account creation, then flips `auth.enabled`.
 *
 * Registered as the Settings dialog's `security` tab directly (DOR-2628): the
 * Access tab that used to wrap it beside the DorkOS account is gone, and the
 * dialog draws the panel's heading.
 */
export function SecurityPanel() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const currentUser = useCurrentUser();
  const signOut = useSignOut();

  const authEnabled = config?.auth?.enabled ?? false;
  const [setupOpen, setSetupOpen] = useState(false);

  function handleToggle(next: boolean) {
    if (next) {
      // Create the owner first; the flag flips once the account exists.
      setSetupOpen(true);
    } else {
      updateConfig.mutate({ auth: { enabled: false } });
    }
  }

  async function enableLogin() {
    await updateConfig.mutateAsync({ auth: { enabled: true } });
    setSetupOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {/* No heading here: the Settings dialog draws the panel's own
            ("Login & security"). This is its explainer. */}
        <p className="text-muted-foreground text-sm">
          Require an owner login to reach this computer. Exposing DorkOS beyond localhost (a tunnel
          or non-loopback bind) always requires login.
        </p>
      </div>

      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Require login"
            description={
              authEnabled
                ? 'An owner account is required to use DorkOS on this computer.'
                : 'Off. DorkOS on this computer starts with no login (localhost only).'
            }
          >
            <Switch
              checked={authEnabled}
              onCheckedChange={handleToggle}
              aria-label="Require login"
            />
          </SettingRow>

          {authEnabled && (
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

      {/* The standing answer a person can give about being asked: what they
          are no longer asked about. Draws nothing until there is something on
          file. */}
      <AutonomyAcknowledgementRow />

      {/* Keys outlive the login flag, so this card must too (DOR-1885). Turning
          "Require login" off deletes no key, ends no session and stops nothing
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

      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an owner account</DialogTitle>
            <DialogDescription>
              This becomes the login for this computer. Email is a local identifier only.
            </DialogDescription>
          </DialogHeader>
          <OwnerSetupScreen
            submitLabel="Create account & require login"
            onCreated={enableLogin}
            onOwnerExists={enableLogin}
            onCancel={() => setSetupOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
