import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  Switch,
} from '@/layers/shared/ui';
import { useUpdateConfig } from '@/layers/entities/config';
import { formatTrustWindow } from '../lib/format-trust-window';
import { useStandingGrantPolicy } from '../model/use-standing-grant-policy';
import { useStandingPermissions } from '../model/use-standing-permissions';
import { StandingPermissionList } from './StandingPermissionList';

/**
 * The windows a person can pick from, in minutes.
 *
 * Every one is inside the schema's own bounds (5 minutes to one day), and one day
 * is the top because "forever" is deliberately not expressible.
 */
const WINDOW_CHOICES = [30, 60, 120, 240, 480, 720, 1440];

/**
 * Standing permissions in Settings, under Security — the canonical home
 * (spec `agent-approval-settings` §3.7).
 *
 * Three things live here: the master switch, how long a new permission lasts, and
 * every permission that is live right now with a button to end it. The header
 * panel mirrors the list; this is the place a person goes when they are looking
 * rather than stumbling.
 *
 * ## With Require login off, this is visible and disabled
 *
 * Not hidden, and not quietly degraded into something weaker. Creating a
 * permission needs a session cookie, and with login off there is no cookie for
 * anybody — DorkOS genuinely cannot tell the person in the cockpit from an agent
 * running as the same user, so "trust this agent" is not a statement it can
 * evaluate (§3.0). Any weaker check would be one an agent can satisfy exactly as
 * easily as the operator, which would assert a distinction that does not exist.
 *
 * Hiding the control instead would leave somebody looking for a feature they read
 * about with nothing to find. So it stays on screen, switched off, with the plain
 * reason and with the fix — the Require login toggle — directly above it in the
 * same panel.
 *
 * ## Turning the master switch off ends every live permission
 *
 * Said in those words in the confirmation, because it is the part a person would
 * not otherwise expect. The alternative, leaving rows dormant, would let trust
 * somebody switched off wake up later when they switched it back on, and nobody
 * would have decided that.
 */
export function StandingPermissionsSettings() {
  const { standingGrantsEnabled, loginEnabled, windowMinutes } = useStandingGrantPolicy();
  const { permissions } = useStandingPermissions();
  const updateConfig = useUpdateConfig();
  const [confirmingOff, setConfirmingOff] = useState(false);

  function handleToggle(next: boolean) {
    // Turning it ON grants nothing, so it needs no confirmation. Turning it OFF
    // ends live permissions, which is a consequence worth naming first.
    if (!next && permissions.length > 0) {
      setConfirmingOff(true);
      return;
    }
    updateConfig.mutate({ approvals: { standingGrants: next } });
  }

  const liveCount = permissions.length;

  return (
    <>
      <SettingRow
        label="Standing permissions"
        description={
          loginEnabled
            ? 'Let yourself answer "stop asking about this" from an approval card, for one agent and one action at a time.'
            : 'Turn on Require login above to use this. Without it, DorkOS cannot tell you apart from an agent running on this machine.'
        }
      >
        {/* Reads OFF whenever login is off, even if the stored switch says true.
            That is not a display trick: with login off the server refuses to open
            a permission, the gate honors none, and turning login off already ended
            every live one. Drawing it as on would be the lie. */}
        <Switch
          checked={standingGrantsEnabled && loginEnabled}
          disabled={!loginEnabled || updateConfig.isPending}
          onCheckedChange={handleToggle}
          aria-label="Standing permissions"
        />
      </SettingRow>

      {standingGrantsEnabled && loginEnabled && (
        <>
          <SettingRow
            label="How long each one lasts"
            description="Counted from the moment you grant it. Using a permission never extends it."
          >
            <Select
              value={String(windowMinutes)}
              onValueChange={(value) =>
                updateConfig.mutate({ approvals: { trustWindowMinutes: Number(value) } })
              }
            >
              <SelectTrigger className="w-36" aria-label="How long each one lasts">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* A window somebody set through the CLI that is not on this list
                    still has to be selectable, or opening the picker would silently
                    change their setting to the nearest option. */}
                {[...new Set([...WINDOW_CHOICES, windowMinutes])]
                  .sort((a, b) => a - b)
                  .map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {formatTrustWindow(minutes)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <div className="space-y-2 px-4 py-3">
            <p className="text-sm font-medium">
              {liveCount === 0 ? 'Nothing is trusted right now' : `Live right now (${liveCount})`}
            </p>
            {liveCount === 0 ? (
              <p className="text-muted-foreground text-xs">
                When you answer &ldquo;stop asking about this&rdquo; on an approval card, it shows
                up here until it runs out.
              </p>
            ) : (
              <StandingPermissionList permissions={permissions} />
            )}
          </div>
        </>
      )}

      <AlertDialog open={confirmingOff} onOpenChange={setConfirmingOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off standing permissions?</AlertDialogTitle>
            <AlertDialogDescription>
              {liveCount === 1
                ? 'This ends the one permission that is live right now. That agent will be asked again before its next action.'
                : `This ends all ${liveCount} permissions that are live right now. Those agents will be asked again before their next action.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => updateConfig.mutate({ approvals: { standingGrants: false } })}
            >
              Turn off and end them
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
