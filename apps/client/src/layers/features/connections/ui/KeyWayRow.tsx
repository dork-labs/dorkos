import { useState } from 'react';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { useDeleteConnectorCredential } from '@/layers/entities/connectors';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from '@/layers/shared/ui';
import { appCount, keyWayName, type WayApp } from '../lib/connection-ways';
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
 * One of your own keys (Composio, Nango) as a way DorkOS reaches your apps:
 * whether it works, how many apps use it, and Change key / Remove….
 *
 * Remove lists every app that stops working and the button says how many,
 * because the whole point of the confirmation is knowing what you lose.
 */
export function KeyWayRow({
  status,
  apps,
}: {
  /** The key's setup status from `GET /api/connectors/providers`. */
  status: ConnectorProviderStatus;
  /** The live apps that reach their service through this key. */
  apps: readonly WayApp[];
}) {
  const [changing, setChanging] = useState(false);
  const remove = useDeleteConnectorCredential();
  const name = providerName(status.type);
  const kind = status.configured ? keyKindLine(status.keyKind) : null;
  const detail = [`${appCount(apps.length)} connected`, kind].filter(Boolean).join(' · ');

  return (
    <WayRow
      testId={`connection-way-${status.type}`}
      name={keyWayName(status.type)}
      detail={detail}
      status={keyStatus(status)}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setChanging((open) => !open)}>
            {status.configured ? 'Change key' : 'Add key again'}
          </Button>
          {status.configured && (
            <RemoveKeyDialog
              name={name}
              apps={apps}
              pending={remove.isPending}
              onConfirm={() => remove.mutate({ provider: status.type })}
            />
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
          These apps stopped working when the key was removed. Add it again to bring them back.
        </p>
      )}
      {changing && (
        <div className="space-y-2">
          {status.configured && apps.length > 0 && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Use a key from the same {name} account. A key from another account stops the{' '}
              {appCount(apps.length)} connected with this one.
            </p>
          )}
          <ConnectionKeyForm
            type={status.type}
            submitLabel="Save key"
            onSaved={() => setChanging(false)}
            onCancel={() => setChanging(false)}
          />
        </div>
      )}
    </WayRow>
  );
}

/** "Remove…" and its confirmation, which names every app that stops. */
function RemoveKeyDialog({
  name,
  apps,
  pending,
  onConfirm,
}: {
  name: string;
  apps: readonly WayApp[];
  pending: boolean;
  onConfirm: () => void;
}) {
  const confirmLabel =
    apps.length > 0 ? `Remove key and stop ${appCount(apps.length)}` : 'Remove key';
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={pending}>
          {pending ? 'Removing…' : 'Remove…'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove your {name} key?</AlertDialogTitle>
          <AlertDialogDescription>
            {apps.length > 0
              ? `${apps.length === 1 ? 'This app' : `These ${apps.length} apps`} will stop working for every agent:`
              : 'No apps use this key right now.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {apps.length > 0 && (
          <>
            <ul className="text-foreground max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
              {apps.map((app) => (
                <li key={app.connectionId}>
                  {app.name}
                  {app.agentCount > 0 && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {app.agentCount} {app.agentCount === 1 ? 'agent' : 'agents'} use it
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm">
              Your sign-ins are not deleted. Add the same key again to bring these apps back.
            </p>
          </>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep key</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
