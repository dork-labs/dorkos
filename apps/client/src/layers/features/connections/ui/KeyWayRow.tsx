import { useState } from 'react';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import {
  appCount,
  ConnectionImpactList,
  splitByImpact,
  useDeleteConnectorCredential,
  type ImpactApp,
} from '@/layers/entities/connectors';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@/layers/shared/ui';
import { keyWayName } from '../lib/connection-ways';
import { providerName } from '../lib/presentation';
import { ConnectionKeyForm } from './ConnectionKeyForm';
import { WayRow, type WayStatus } from './WayRow';

/** Which saved key validated, when the server knows. */
function keyKindLine(keyKind: ConnectorProviderStatus['keyKind']): string | null {
  if (keyKind === 'user') return 'using your account key';
  if (keyKind === 'project') return 'using your project key';
  return null;
}

/** The honest state of one of your own keys, in words. */
function keyStatus(status: ConnectorProviderStatus): WayStatus {
  if (status.registered) return { tone: 'success', label: 'Working' };
  // Saved but refused: the server's reason is shown under the row.
  if (status.configured) return { tone: 'error', label: 'Not working' };
  // Only reached when apps still point at a key that was removed.
  return { tone: 'warning', label: 'Key removed' };
}

/**
 * What the apps on a key belong to. A different key for the same place keeps
 * reaching them; a key for another place cannot see them at all.
 */
function keyScope(type: string): string {
  if (type === 'composio') return 'Composio project';
  if (type === 'nango') return 'Nango environment';
  return `${providerName(type)} account`;
}

/** Which confirmation, if any, is open. */
type Confirming = 'change' | 'remove' | null;

/**
 * One of your own keys (Composio, Nango) as a way DorkOS reaches your apps:
 * whether it works, how many apps use it, and Change key / Remove….
 *
 * Both actions sit behind a confirmation that names every app they touch,
 * because both stop apps. Removing a key stops every app on it. Changing it
 * stops them too, for longer than it looks: the server re-checks the new key
 * before using it (a typo stops everything), and ANY new key string changes
 * what the server trusts, so every app on it pauses until its access is
 * reviewed again. A key from another project cannot reach those apps at all.
 */
export function KeyWayRow({
  status,
  apps,
  usedForNewApps = false,
}: {
  /** The key's setup status from `GET /api/connectors/providers`. */
  status: ConnectorProviderStatus;
  /** The live apps that reach their service through this key. */
  apps: readonly ImpactApp[];
  /** True when new apps connect through this key (see {@link WayRow}). */
  usedForNewApps?: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const remove = useDeleteConnectorCredential();
  const name = providerName(status.type);
  const kind = status.configured ? keyKindLine(status.keyKind) : null;
  const detail = [`${appCount(apps.length)} connected`, kind].filter(Boolean).join(' · ');
  const { stopping, idle } = splitByImpact(apps, status.registered);

  const startChange = () => {
    // Nothing to lose: go straight to the form.
    if (apps.length === 0 || !status.configured) setChanging(true);
    else setConfirming('change');
  };

  return (
    <WayRow
      testId={`connection-way-${status.type}`}
      name={keyWayName(status.type)}
      detail={detail}
      status={keyStatus(status)}
      usedForNewApps={usedForNewApps}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={startChange} disabled={changing}>
            {status.configured ? 'Change key' : 'Add key again'}
          </Button>
          {status.configured && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={() => setConfirming('remove')}
            >
              {remove.isPending ? 'Removing…' : 'Remove…'}
            </Button>
          )}
        </>
      }
    >
      {status.error && (
        <p
          role="alert"
          className="text-destructive border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs leading-relaxed"
        >
          {status.error}
        </p>
      )}
      {!status.configured && apps.length > 0 && (
        <p className="text-muted-foreground text-xs">
          These apps stopped working when the key was removed. Add the same key again to bring them
          back.
        </p>
      )}
      {changing && (
        <ConnectionKeyForm
          type={status.type}
          submitLabel="Save key"
          onSaved={() => setChanging(false)}
          onCancel={() => setChanging(false)}
        />
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          {confirming === 'change' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Change your {name} key?</AlertDialogTitle>
                <AlertDialogDescription>
                  A new key pauses the apps on this one until you review their access again. A key
                  from a different {keyScope(status.type)} can’t reach them at all.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ConnectionImpactList
                stopping={stopping}
                idle={idle}
                stopLine={
                  stopping.length === 1
                    ? 'This app pauses until you review its access on the Connections page:'
                    : `These ${stopping.length} apps pause until you review their access on the Connections page:`
                }
              />
              <p className="text-muted-foreground text-sm">
                Nothing changes until you save the new key. If it doesn’t work, every app on this
                key stops until you fix it.
              </p>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep this key</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirming(null);
                    setChanging(true);
                  }}
                >
                  {/* Only opens the form: nothing pauses until the new key is saved. */}
                  Continue to a new key
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove your {name} key?</AlertDialogTitle>
                <AlertDialogDescription>
                  {apps.length === 0
                    ? 'No apps use this key right now.'
                    : 'Your sign-ins are not deleted. Add the same key again to bring these apps back.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ConnectionImpactList
                stopping={stopping}
                idle={idle}
                stopLine={`${stopping.length === 1 ? 'This app' : `These ${stopping.length} apps`} will stop working for every agent:`}
              />
              <AlertDialogFooter>
                <AlertDialogCancel>Keep key</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => remove.mutate({ provider: status.type })}
                  className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
                >
                  {stopping.length > 0
                    ? `Remove key and stop ${appCount(stopping.length)}`
                    : 'Remove key'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </WayRow>
  );
}
