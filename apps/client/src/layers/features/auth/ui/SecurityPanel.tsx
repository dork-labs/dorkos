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
import {
  AutonomyAcknowledgementRow,
  StandingPermissionsSettings,
} from '@/layers/features/approvals';
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { ApiKeysSection } from './ApiKeysSection';
import { useCurrentUser, useSignOut } from '../model/use-auth-session';

/**
 * Security section for the Settings dialog — the single entry point to local
 * login. Progressive disclosure: when login is off, only the "Require login"
 * toggle shows (no user, no sign-out, no API keys). Enabling it walks the user
 * through owner-account creation, then flips `auth.enabled`.
 *
 * Composed into the Settings dialog's Access tab (a `features/settings` UI
 * that renders this `features/auth` panel — sibling UI composition).
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
        {/* No heading here: the Access tab draws the section heading this
            sits under ("On this machine"). This is its explainer. */}
        <p className="text-muted-foreground text-sm">
          Require an owner login to reach this instance. Exposing DorkOS beyond localhost (a tunnel
          or non-loopback bind) always requires login.
        </p>
      </div>

      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Require login"
            description={
              authEnabled
                ? 'An owner account is required to use this instance.'
                : 'Off — this instance starts with no login (localhost only).'
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

      {/* Standing permissions live directly under Require login, and not behind
          it. The control needs login on, so the fix has to be the thing directly
          above it — hiding it until login is on would leave somebody looking for
          a feature they read about with nothing to find, and no way to learn what
          turning login on would buy them. */}
      <FieldCard>
        <FieldCardContent>
          <StandingPermissionsSettings />
          {/* The other standing answer a person can give about being asked —
              in the same card, because "what am I no longer being asked about"
              is one question. Draws nothing until there is something on file. */}
          <AutonomyAcknowledgementRow />
        </FieldCardContent>
      </FieldCard>

      {authEnabled && (
        <FieldCard>
          <FieldCardContent>
            <ApiKeysSection />
          </FieldCardContent>
        </FieldCard>
      )}

      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an owner account</DialogTitle>
            <DialogDescription>
              This becomes the login for this instance. Email is a local identifier only.
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
