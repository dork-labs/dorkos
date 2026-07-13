import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
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
  Checkbox,
  FieldCard,
  FieldCardContent,
  Skeleton,
} from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { cn, formatRelativeTime, useCopyFeedback } from '@/layers/shared/lib';
import { useCloudLink, type CloudLinkView } from '../model/use-cloud-link';

/**
 * DorkOS account section for the Settings dialog — links or unlinks this
 * instance to a DorkOS account. Always available: local login and the cloud link
 * are independent systems, so this panel never gates on the auth session.
 *
 * All flow state lives in {@link useCloudLink}; this component only renders the
 * current view and wires the buttons. Composed into Settings via a
 * `features/settings` tab (sibling UI composition).
 */
export function CloudLinkPanel() {
  const { view, start, unlink, starting, unlinking, startError } = useCloudLink();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Link2 className="text-muted-foreground size-4" />
          <h2 className="text-sm font-semibold">DorkOS account</h2>
        </div>
        <p className="text-muted-foreground text-sm">
          Link this instance to a DorkOS account to reach it from dorkos.ai and receive updates.
          Linking is independent of local login.
        </p>
      </div>

      <FieldCard>
        <FieldCardContent>
          <CloudLinkBody
            view={view}
            start={start}
            unlink={unlink}
            starting={starting}
            unlinking={unlinking}
            startError={startError}
          />
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}

interface BodyProps {
  view: CloudLinkView;
  start: () => Promise<void>;
  unlink: () => Promise<void>;
  starting: boolean;
  unlinking: boolean;
  startError: string | null;
}

/** Render the state-specific body for the current {@link CloudLinkView}. */
function CloudLinkBody({ view, start, unlink, starting, unlinking, startError }: BodyProps) {
  switch (view.kind) {
    case 'loading':
      return <Skeleton className="h-9 w-40" />;
    case 'idle':
      return <IdleState start={start} starting={starting} startError={startError} />;
    case 'pending':
      return <PendingState view={view} />;
    case 'linked':
      return <LinkedState view={view} unlink={unlink} unlinking={unlinking} />;
    case 'expired':
      return (
        <RecoveryState
          title="Your code expired"
          description="The link code timed out before it was approved. Generate a new one to try again."
          actionLabel="Generate a new code"
          onAction={start}
          pending={starting}
        />
      );
    case 'denied':
      return (
        <RecoveryState
          title="Link request denied"
          description="The request was rejected on dorkos.ai. Start again if that wasn't intentional."
          actionLabel="Try again"
          onAction={start}
          pending={starting}
        />
      );
    case 'revoked':
      return (
        <RecoveryState
          title="This instance was unlinked"
          description="DorkOS revoked this instance's access. Link again to reconnect it to your account."
          actionLabel="Link again"
          onAction={start}
          pending={starting}
        />
      );
  }
}

/** Not linked, no flow in progress — the entry point. */
function IdleState({
  start,
  starting,
  startError,
}: {
  start: () => Promise<void>;
  starting: boolean;
  startError: string | null;
}) {
  const checkboxId = useId();
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const persisted = config?.telemetry?.linkAnalyticsToAccount ?? false;
  const [linkAnalytics, setLinkAnalytics] = useState(persisted);

  // Mirror the persisted flag once config loads (or if it changes elsewhere), so
  // a re-linking operator sees their prior choice pre-selected.
  useEffect(() => {
    setLinkAnalytics(persisted);
  }, [persisted]);

  const [consentError, setConsentError] = useState<string | null>(null);

  // Persist the choice BEFORE starting the handshake: the descriptor is built
  // server-side at link time, so the flag must be on disk first. Fail CLOSED on
  // a write failure — never start the link. Proceeding would act on the stale
  // persisted flag in both directions: an opt-in would silently skip the merge,
  // and (worse) an unchecked box over a previously-persisted `true` would send
  // the id against an explicit withdrawal.
  const handleLink = useCallback(async () => {
    setConsentError(null);
    try {
      await updateConfig.mutateAsync({ telemetry: { linkAnalyticsToAccount: linkAnalytics } });
    } catch {
      setConsentError("Couldn't save your choice. Try again.");
      return;
    }
    await start();
  }, [updateConfig, linkAnalytics, start]);

  const busy = starting || updateConfig.isPending;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        This instance is not linked to a DorkOS account.
      </p>

      <div className="flex items-start gap-2.5">
        <Checkbox
          id={checkboxId}
          checked={linkAnalytics}
          onCheckedChange={(v) => setLinkAnalytics(v === true)}
          disabled={busy}
          className="mt-0.5"
        />
        <label htmlFor={checkboxId} className="space-y-1 text-sm leading-snug">
          <span className="font-medium">Also connect this app's usage data to my account</span>
          <span className="text-muted-foreground block text-xs">
            Links the anonymous usage counts from this install to your account so you can see them
            signed in. Off by default. Takes effect at link time, so turning it on after linking
            only applies the next time you link.
          </span>
        </label>
      </div>

      <Button onClick={() => void handleLink()} disabled={busy}>
        {busy ? (
          <Loader2 className="mr-1.5 size-4 animate-spin" />
        ) : (
          <Link2 className="mr-1.5 size-4" />
        )}
        {busy ? 'Starting…' : 'Link this instance'}
      </Button>
      {(consentError ?? startError) && (
        <p className="text-sm text-red-500" role="alert">
          {consentError ?? startError}
        </p>
      )}
    </div>
  );
}

/** A device flow is in progress — show the code and the activation link. */
function PendingState({ view }: { view: Extract<CloudLinkView, { kind: 'pending' }> }) {
  const [copied, copy] = useCopyFeedback();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">Enter this code to link</p>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded-md px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums">
            {view.userCode}
          </code>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-2 transition-colors"
            onClick={() => copy(view.userCode)}
            aria-label="Copy code"
          >
            {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
          </button>
        </div>
      </div>

      <Button
        variant="outline"
        onClick={() => openVerification(view.verificationUri, view.userCode)}
      >
        <ExternalLink className="mr-1.5 size-4" />
        Open dorkos.ai/activate
      </Button>

      <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2 className="size-4 animate-spin" />
        <span>Waiting for you to approve on dorkos.ai…</span>
      </div>
    </div>
  );
}

/** Linked — show the account, last sync, and the unlink action. */
function LinkedState({
  view,
  unlink,
  unlinking,
}: {
  view: Extract<CloudLinkView, { kind: 'linked' }>;
  unlink: () => Promise<void>;
  unlinking: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-green-500" aria-hidden />
            <p className="text-sm font-medium">Linked</p>
          </div>
          {view.accountLabel ? (
            <p className="text-foreground truncate text-sm">{view.accountLabel}</p>
          ) : (
            <p className="text-muted-foreground text-sm">Syncing account…</p>
          )}
          {view.lastHeartbeatAt && (
            <p className="text-muted-foreground text-xs">
              Last synced {formatRelativeTime(view.lastHeartbeatAt).toLowerCase()}
            </p>
          )}
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={unlinking}
              aria-label="Unlink this instance"
            >
              <Unplug className={cn('mr-1.5 size-3.5', unlinking && 'animate-pulse')} />
              {unlinking ? 'Unlinking…' : 'Unlink'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unlink this instance?</AlertDialogTitle>
              <AlertDialogDescription>
                This instance will stop reporting to your DorkOS account. You can link it again at
                any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void unlink()}>Unlink</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

/** Shared layout for the expired / denied / revoked recovery states. */
function RecoveryState({
  title,
  description,
  actionLabel,
  onAction,
  pending,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => Promise<void>;
  pending: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
      </div>
      <Button onClick={() => void onAction()} disabled={pending}>
        {pending ? (
          <Loader2 className="mr-1.5 size-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-1.5 size-4" />
        )}
        {actionLabel}
      </Button>
    </div>
  );
}

/**
 * Open the activation page in a new tab, code pre-filled. Guarded: only `http`/
 * `https` URLs from the server response are opened, never a `javascript:` or
 * other scheme, and a malformed URL is ignored.
 */
function openVerification(verificationUri: string, userCode: string): void {
  try {
    const url = new URL(verificationUri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    url.searchParams.set('code', userCode);
    window.open(url.href, '_blank', 'noopener,noreferrer');
  } catch {
    // Malformed URL — do nothing rather than open something unexpected.
  }
}
