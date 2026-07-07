import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
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
import { OwnerSetupScreen } from './OwnerSetupScreen';
import { ApiKeysSection } from './ApiKeysSection';
import { useCurrentUser, useSignOut } from '../model/use-auth-session';

/**
 * Security section for the Settings dialog — the single entry point to local
 * login. Progressive disclosure: when login is off, only the "Require login"
 * toggle shows (no user, no sign-out, no API keys). Enabling it walks the user
 * through owner-account creation, then flips `auth.enabled`.
 *
 * Composed into the Settings dialog's Security tab (a `features/settings` UI
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
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground size-4" />
          <h2 className="text-sm font-semibold">Security</h2>
        </div>
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
