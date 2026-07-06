'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { revokeInstanceLink } from '@/lib/auth-client';
import type { InstanceView } from '@/lib/instance-types';
import { cn } from '@/lib/utils';
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
  Badge,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/layers/shared/ui';

import { relativeTime } from '../lib/relative-time';

/**
 * `/account/instances` — the device-linked instance registry
 * (accounts-and-auth P2, task 2.3).
 *
 * Lists the signed-in account's linked instances (name, platform, version,
 * last-seen, linked date) with a per-row Revoke behind a confirmation dialog.
 * The initial rows are rendered server-side and passed in; revoking calls the
 * endpoint via the auth-client wrapper and refreshes the server component.
 *
 * @param props.instances - The account's instances, newest first.
 */
export function InstanceRegistry({ instances }: { instances: InstanceView[] }) {
  if (instances.length === 0) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-xl">Linked instances</CardTitle>
          <CardDescription>
            No instances are linked yet. Run <code className="font-mono">dorkos cloud login</code>{' '}
            on an instance (or link it from its Settings) to attach it to your DorkOS account.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-xl">Linked instances</CardTitle>
        <CardDescription>
          Instances attached to your DorkOS account. Revoke one to unlink it immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {instances.map((it) => (
          <InstanceRow key={it.id} instance={it} />
        ))}
      </CardContent>
    </Card>
  );
}

/** One instance row with its details and a revoke affordance. */
function InstanceRow({ instance }: { instance: InstanceView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const revoked = instance.revokedAt !== null;

  async function onConfirmRevoke() {
    setPending(true);
    try {
      await revokeInstanceLink(instance.id);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{instance.name}</span>
          {revoked ? <Badge variant="outline">Revoked</Badge> : null}
        </div>
        <span className="text-muted-foreground text-xs">
          {instance.platform} · v{instance.dorkosVersion}
        </span>
        <span className="text-muted-foreground text-xs">
          {revoked
            ? `Revoked ${relativeTime(instance.revokedAt as string)}`
            : `Last seen ${relativeTime(instance.lastSeenAt)}`}{' '}
          · Linked {relativeTime(instance.createdAt)}
        </span>
      </div>
      {revoked ? null : (
        <AlertDialog>
          <AlertDialogTrigger
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            disabled={pending}
          >
            Revoke
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {instance.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This unlinks the instance and invalidates its key. It will need to link again to
                reconnect. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onConfirmRevoke()} disabled={pending}>
                {pending ? 'Revoking…' : 'Revoke'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
