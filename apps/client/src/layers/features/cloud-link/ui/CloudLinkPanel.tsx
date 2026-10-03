import { Link2, RefreshCw, TriangleAlert, Unplug, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  SettingRow,
  Skeleton,
  Spinner,
} from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import {
  appCount,
  ConnectionImpactList,
  dorkosAccountApps,
  splitByImpact,
  useConnectorConnections,
} from '@/layers/entities/connectors';
import { cn, formatRelativeTime, useRenderSlot } from '@/layers/shared/lib';
import { SETTINGS_RELINK_SECTION, useSettingsDeepLink } from '@/layers/shared/model';
import { useCloudLink, useCloudStatus, type CloudLinkView } from '../model/use-cloud-link';
import { PendingLinkCode } from './PendingLinkCode';

/** How a relink that did not replace the link ended, as the linked view carries it. */
type CloudLinkRelinkOutcome = Extract<CloudLinkView, { kind: 'linked' }>['relinkOutcome'];

/** Props for {@link CloudLinkPanel}. */
export interface CloudLinkPanelProps {
  /**
   * The page shown before this computer is linked — what an account would add
   * here — drawn above the link controls. The caller owns it because only the
   * caller knows which benefits the server reports as wired.
   */
  signedOut?: ReactNode;
  /**
   * The signed-in sections, drawn between the account line and "Unlink this
   * computer" once linked.
   */
  children?: ReactNode;
}

/**
 * The DorkOS account, from not linked to linked: the device-link flow and its
 * recovery states before, the account line, "Link again" and "Unlink this
 * computer" after, with the caller's own content in each half. Always
 * available: local login and the account link are independent systems, so
 * this never gates on the auth session.
 *
 * All flow state lives in {@link useCloudLink}, and this is its ONE caller on
 * screen — the signed-in content arrives as children rather than reading the
 * flow a second time, so two copies of the poll can never race.
 *
 * Composed into Settings › DorkOS account (sibling UI composition).
 *
 * @param props - The two halves' content. See {@link CloudLinkPanelProps}.
 */
export function CloudLinkPanel({ signedOut, children }: CloudLinkPanelProps) {
  const { view, start, unlink, cancel, starting, unlinking, startError } = useCloudLink();
  useRelinkRequest(view, start);
  // A relink keeps this computer linked while its code is showing, so the
  // signed-out page (what an account WOULD add) is not drawn over it.
  const alreadyLinked = useCloudStatus().data?.linked === true;

  if (view.kind === 'loading') return <Skeleton className="h-24 w-full" />;

  if (view.kind === 'linked') {
    return (
      <div className="space-y-4">
        <LinkedState
          view={view}
          start={start}
          starting={starting}
          startError={startError}
          dismiss={cancel}
        />
        {children}
        <UnlinkSection unlink={unlink} unlinking={unlinking} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!alreadyLinked && signedOut}
      <FieldCard>
        <FieldCardContent>
          <CloudLinkBody
            view={view}
            start={start}
            cancel={cancel}
            starting={starting}
            startError={startError}
            relinking={alreadyLinked}
          />
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}

/**
 * Start linking again when Settings was opened to do that (from a "Link my
 * DorkOS account again" button elsewhere), so one click gets a person to a
 * fresh link code. Acts once the panel knows its state, never while a code is
 * already showing, and clears the section so the request is spent.
 */
function useRelinkRequest(view: CloudLinkView, start: () => Promise<void>): void {
  const { section, setSection } = useSettingsDeepLink();
  const handled = useRef(false);
  const requested = section === SETTINGS_RELINK_SECTION;
  useEffect(() => {
    if (!requested) {
      handled.current = false;
      return;
    }
    if (handled.current || view.kind === 'loading') return;
    handled.current = true;
    setSection(null);
    if (view.kind !== 'pending') void start();
  }, [requested, view.kind, start, setSection]);
}

interface BodyProps {
  view: Exclude<CloudLinkView, { kind: 'loading' } | { kind: 'linked' }>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  starting: boolean;
  startError: string | null;
  /** This computer is still linked: the code on screen is for a NEW link. */
  relinking: boolean;
}

/** Render the state-specific body for a not-yet-linked {@link CloudLinkView}. */
function CloudLinkBody({ view, start, cancel, starting, startError, relinking }: BodyProps) {
  switch (view.kind) {
    case 'idle':
      return <IdleState start={start} starting={starting} startError={startError} />;
    case 'pending':
      // Keyed by the code so a fresh code starts a fresh countdown and clears
      // any error left over from the last one.
      return (
        <PendingLinkCode key={view.userCode} view={view} cancel={cancel} relinking={relinking} />
      );
    case 'expired':
      return (
        <RecoveryState
          title="Your code expired"
          description="It ran out before you approved it."
          actionLabel="Get a new code"
          onAction={start}
          pending={starting}
        />
      );
    case 'denied':
      return (
        <RecoveryState
          title="Link request denied"
          description="It was turned down on dorkos.ai."
          actionLabel="Link this computer"
          onAction={start}
          pending={starting}
        />
      );
    case 'revoked':
      return (
        <RecoveryState
          title="This computer was unlinked"
          description="DorkOS removed its access to your account."
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
  // The box follows the persisted flag until the operator touches it, so a
  // re-linking operator sees their prior choice pre-selected, and a config that
  // loads (or changes elsewhere) afterwards wins again — which is what the
  // effect this replaces did, without the extra render.
  //
  // The tick is stamped against a GENERATION rather than the persisted value
  // itself. A flag has two values, so it comes back to the one a tick was made
  // over almost immediately, and a stamp made of the value cannot tell that new
  // reading from the old one — the stale tick would then win over the change.
  const persistedReading = useRenderSlot({ value: persisted, generation: 0 });
  if (persistedReading.read().value !== persisted) {
    persistedReading.write({
      value: persisted,
      generation: persistedReading.read().generation + 1,
    });
  }
  const persistedGeneration = persistedReading.read().generation;

  const [ticked, setTicked] = useState<{ generation: number; value: boolean } | null>(null);
  const linkAnalytics =
    ticked !== null && ticked.generation === persistedGeneration ? ticked.value : persisted;
  const setLinkAnalytics = (value: boolean) =>
    setTicked({ generation: persistedGeneration, value });

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
      setConsentError('Couldn’t save your choice. Try again.');
      return;
    }
    await start();
  }, [updateConfig, linkAnalytics, start]);

  const busy = starting || updateConfig.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={checkboxId}
          checked={linkAnalytics}
          onCheckedChange={(v) => setLinkAnalytics(v === true)}
          disabled={busy}
          className="mt-0.5"
        />
        <label htmlFor={checkboxId} className="space-y-1 text-sm leading-snug">
          <span className="font-medium">Link usage counts to your account</span>
          <span className="text-muted-foreground block text-xs">
            See this install’s anonymous usage counts when signed in.
          </span>
          <span className="text-muted-foreground block text-xs">
            Applies when you link. To change it later, link again.
          </span>
        </label>
      </div>

      <Button onClick={() => void handleLink()} disabled={busy}>
        {busy ? <Spinner className="mr-1.5" /> : <Link2 className="mr-1.5 size-(--size-icon-sm)" />}
        {busy ? 'Starting…' : 'Link this computer'}
      </Button>
      {(consentError ?? startError) && (
        <p className="text-destructive text-sm" role="alert">
          {consentError ?? startError}
        </p>
      )}
    </div>
  );
}

/**
 * Linked — who this computer is signed in as, when it last heard from the
 * account, and "Link again". Linking again keeps this computer linked until the
 * new link is approved, and is how a link that needs updating picks up the
 * update. Unlinking is the page's last section, not a button up here.
 */
function LinkedState({
  view,
  start,
  starting,
  startError,
  dismiss,
}: {
  view: Extract<CloudLinkView, { kind: 'linked' }>;
  start: () => Promise<void>;
  starting: boolean;
  startError: string | null;
  dismiss: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      {view.relinkOutcome && <RelinkNote outcome={view.relinkOutcome} dismiss={dismiss} />}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Signed in</p>
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
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void start()}
          disabled={starting}
        >
          {starting ? <Spinner className="mr-1.5" /> : <RefreshCw className="mr-1.5 size-3.5" />}
          Link again
        </Button>
      </div>
      {startError && (
        <p role="alert" className="text-destructive text-sm">
          {startError}
        </p>
      )}
    </div>
  );
}

/** The last thing on the signed-in page: taking this computer off the account. */
function UnlinkSection({ unlink, unlinking }: { unlink: () => Promise<void>; unlinking: boolean }) {
  return (
    <FieldCard>
      <FieldCardContent>
        <SettingRow
          label="Unlink this computer"
          description="Stops using your DorkOS account. You can link again anytime."
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={unlinking}
                aria-label="Unlink this computer"
              >
                <Unplug className={cn('mr-1.5 size-3.5', unlinking && 'animate-pulse')} />
                {unlinking ? 'Unlinking…' : 'Unlink'}
              </Button>
            </AlertDialogTrigger>
            <UnlinkConfirm unlink={unlink} />
          </AlertDialog>
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}

const RELINK_NOTE: Record<NonNullable<CloudLinkRelinkOutcome>, string> = {
  denied: 'The new link was turned down on dorkos.ai.',
  expired: 'The new link’s code expired.',
  failed: 'The new link couldn’t finish.',
};

/**
 * Why a relink didn't finish, on a computer that never stopped being linked.
 * Quiet on purpose: nothing is broken, so it reads as a note, not an alarm.
 */
function RelinkNote({
  outcome,
  dismiss,
}: {
  outcome: NonNullable<CloudLinkRelinkOutcome>;
  dismiss: () => Promise<void>;
}) {
  return (
    <div role="status" className="bg-muted/40 flex items-start gap-2 rounded-lg p-3 text-sm">
      <p className="min-w-0 flex-1">{RELINK_NOTE[outcome]} This computer is still linked.</p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="-my-1 shrink-0"
        onClick={() => void dismiss()}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * The unlink confirmation. Unlinking also stops every app connected through
 * the DorkOS account, so it lists them and the button says how many, the same
 * way removing a key does in Settings › Connections.
 */
function UnlinkConfirm({ unlink }: { unlink: () => Promise<void> }) {
  const connections = useConnectorConnections();
  const apps = connections.data ? dorkosAccountApps(connections.data.connections) : [];
  const { stopping, idle } = splitByImpact(apps);
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Unlink this computer?</AlertDialogTitle>
        <AlertDialogDescription>
          It stops using your DorkOS account. You can link again anytime.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {connections.isPending ? (
        <p className="text-muted-foreground text-sm">Checking which apps use this account…</p>
      ) : connections.isError ? (
        <p className="text-muted-foreground text-sm">
          Couldn’t check which apps use this account. Any that do will stop working.
        </p>
      ) : (
        <ConnectionImpactList
          stopping={stopping}
          idle={idle}
          stopLine={`${stopping.length === 1 ? 'This app' : `These ${stopping.length} apps`} will stop working for every agent:`}
        />
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => void unlink()}>
          {stopping.length > 0 ? `Unlink and stop ${appCount(stopping.length)}` : 'Unlink'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
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
        <TriangleAlert className="text-status-warning-dot mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
      </div>
      <Button onClick={() => void onAction()} disabled={pending}>
        {pending ? (
          <Spinner className="mr-1.5" />
        ) : (
          <RefreshCw className="mr-1.5 size-(--size-icon-sm)" />
        )}
        {actionLabel}
      </Button>
    </div>
  );
}
