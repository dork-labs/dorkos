import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionStartResponse,
} from '@dorkos/shared/community-connections';
import { useTransport } from '@/layers/shared/model';
import { isCommunityAuthorityCurrent, type ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Spinner,
} from '@/layers/shared/ui';
import {
  communityKeys,
  communityOwnerAddress,
  unconfirmedDisconnectMessage,
  useCommunityApprovalCheck,
  useCommunityApprovalStore,
  useCommunityConnections,
  useConfirmedCommunityAuthority,
  useEndCommunityConnection,
  useShowCommunityApproval,
  type CommunityApprovalCheck,
} from '@/layers/entities/community';

/**
 * What to say when a connection could not start.
 *
 * One refusal gets its own words: an address that leads to a host holding
 * several communities (the server's `COMMUNITY_SELECTION_REQUIRED`). The
 * address is right as far as it goes, so "check the address" would send the
 * person looking for a typo that is not there; they need one community's own
 * link, so the example is built on the host they typed. Every other failure keeps the general
 * message.
 *
 * @param error - Why the start failed.
 * @param address - The address the person submitted.
 */
function startErrorMessage(error: unknown, address: string | undefined): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'COMMUNITY_SELECTION_REQUIRED'
  )
    return `That address has more than one community on it. Enter the link for the one you want: its short address, like ${shortAddressExample(address)}, or its full link, which has /c/ in it.`;
  return 'Couldn’t connect. Check the community address and try again.';
}

/** A short address on the host the person typed, or a generic one when it cannot be read. */
function shortAddressExample(address: string | undefined): string {
  try {
    return `${new URL(address ?? '').origin}/your-community`;
  } catch {
    return 'https://spaces.example.com/acme';
  }
}

/** What the connect dialog was opened for. */
export interface ConnectCommunityRequest {
  /** A connection that is not connected yet (pending or needing reconnection), or `null` for the form. */
  ref: string | null;
}

/** Props for {@link ConnectCommunityDialog}. */
export interface ConnectCommunityDialogProps {
  /** What to show, or `null` while the dialog is closed. */
  request: ConnectCommunityRequest | null;
  onOpenChange: (open: boolean) => void;
  /** This installation's name, offered as the name the Community will know it by. */
  installName: string;
  /** Runs once the connection on screen is approved, with its ref, after the dialog closes. */
  onConnected: (ref: string) => void;
}

/** A value that belongs to one confirmed owner, so a switch of owner hides it. */
interface OwnedValue<T> {
  address: string;
  value: T;
}

/** The connection a start returned, and whether the list has answered since. */
interface Started {
  address: string;
  connection: CommunityConnectionDescriptor;
  /** The list has been re-read after the start, so it is the truth from here on. */
  settled: boolean;
}

/**
 * Connect this installation to a Community, in place, from the switcher.
 *
 * One dialog for the whole pairing: the address and installation name, then
 * the wait while the person approves on the Community's own site, then the
 * connected Community selected. Opened on a connection that is still waiting
 * it starts on that wait; opened on one whose access was withdrawn it offers
 * the disconnect that has to come before connecting again.
 *
 * It only reads the wait. The app-level watcher (`useCommunityApprovalWatcher`)
 * does the checking, and hands the ending of the wait on screen to this dialog
 * rather than to a toast. Everything is scoped to the confirmed owner: a
 * switch of owner hides the old owner's links, notices and rows.
 */
export function ConnectCommunityDialog({
  request,
  onOpenChange,
  installName,
  onConnected,
}: ConnectCommunityDialogProps) {
  const authority = useConfirmedCommunityAuthority(true);
  const list = useCommunityConnections(true);
  const address = communityOwnerAddress(authority);
  const open = request !== null;
  const links = useCommunityApprovalStore((state) => state.links);
  const rememberLink = useCommunityApprovalStore((state) => state.rememberLink);
  const ending = useCommunityApprovalStore((state) => state.ending);

  const ownerKey = authority?.ownerKey ?? null;
  // The ref on screen, and the owner it belongs to (`null` when it was chosen
  // before an owner was confirmed; the first confirmed owner adopts it).
  const [shown, setShown] = useState<{ owner: string | null; ref: string } | null>(null);
  const setShownRef = (ref: string | null) =>
    setShown(ref === null ? null : { owner: ownerKey, ref });
  const [notice, setNotice] = useState<OwnedValue<string> | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [handledEnding, setHandledEnding] = useState(ending?.id ?? 0);
  // The last name the wait on screen was shown under, to say which one ended.
  const [lastSeen, setLastSeen] = useState<{ owner: string; ref: string; label: string } | null>(
    null
  );
  // Each opening starts from what it was opened for, not from the last visit.
  const [openedFor, setOpenedFor] = useState<ConnectCommunityRequest | null>(null);
  if (request !== openedFor) {
    setOpenedFor(request);
    if (request) {
      setShownRef(request.ref);
      setNotice(null);
    }
  }
  // A different owner took over: nothing of the old owner's wait may show,
  // not even its name. Back to a clean form, saying nothing about it.
  if (shown !== null && ownerKey !== null && shown.owner !== ownerKey) {
    if (shown.owner === null) setShown({ owner: ownerKey, ref: shown.ref });
    else {
      setShown(null);
      setNotice(null);
      setLastSeen(null);
    }
  }
  const shownRef = shown !== null && shown.owner === ownerKey ? shown.ref : null;

  const listed = shownRef === null ? undefined : list.data?.find((row) => row.ref === shownRef);
  // Until the list is re-read after a start, the start's answer stands in for it.
  const provisional =
    !listed &&
    started !== null &&
    !started.settled &&
    started.address === address &&
    started.connection.ref === shownRef
      ? started.connection
      : null;
  const connection = listed ?? provisional;
  if (
    connection &&
    ownerKey !== null &&
    (lastSeen?.owner !== ownerKey ||
      lastSeen.ref !== connection.ref ||
      lastSeen.label !== connection.label)
  )
    setLastSeen({ owner: ownerKey, ref: connection.ref, label: connection.label });

  // The wait on screen ended, as the watcher saw it (expired, or cancelled on
  // the Community's side). A connected ending is handled below, from the list.
  if (ending && ending.id !== handledEnding) {
    setHandledEnding(ending.id);
    if (ending.ref === shownRef && ending.outcome !== 'connected') {
      setShownRef(null);
      setNotice({
        address,
        value:
          ending.outcome === 'expired'
            ? `Approval for ${ending.label} expired. Connect again to continue.`
            : `Approval for ${ending.label} was cancelled.`,
      });
    }
  }
  // The list, re-read, no longer has it: another window's check found it
  // expired or refused, or it was cancelled elsewhere. Say so, rather than
  // keep waiting on a connection that is gone.
  else if (open && shownRef !== null && !connection && list.isSuccess) {
    const label =
      lastSeen?.owner === ownerKey && lastSeen.ref === shownRef ? lastSeen.label : 'this community';
    setShownRef(null);
    setNotice({
      address,
      value: `Approval for ${label} ended somewhere else. Connect again to continue.`,
    });
  }

  useShowCommunityApproval(open && connection?.status === 'pending' ? connection.ref : null);
  const check = useCommunityApprovalCheck(connection?.status === 'pending' ? connection : null);

  // Approved: the dialog's job is done, and the new Community is selected. Read
  // from the list rather than the check alone, because the list can learn it
  // first (the server announces the change as the check returns).
  const connectedRef = open && connection?.status === 'connected' ? connection.ref : null;
  const latestConnected = useRef(onConnected);
  const latestOpenChange = useRef(onOpenChange);
  useEffect(() => {
    latestConnected.current = onConnected;
    latestOpenChange.current = onOpenChange;
  });
  useEffect(() => {
    if (connectedRef === null || !connection) return;
    toast.success(`${connection.label} is connected.`, {
      id: `community-approval-${connectedRef}`,
    });
    latestOpenChange.current(false);
    latestConnected.current(connectedRef);
    // Keyed on the ref alone: a refreshed descriptor for the same Community is
    // the same news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedRef]);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="!min-h-0 sm:max-w-md">
        <ConnectCommunityBody
          authority={authority}
          connection={connection}
          check={check}
          approvalUrl={
            connection && links?.address === address ? links.urls[connection.ref] : undefined
          }
          notice={notice?.address === address ? notice.value : ''}
          installName={installName}
          onStarted={(result) => {
            rememberLink(address, result.connection.ref, result.approvalUrl);
            setStarted({ address, connection: result.connection, settled: false });
            setShownRef(result.connection.ref);
            setNotice({
              address,
              value: `Next, approve this DorkOS on ${result.connection.label}.`,
            });
          }}
          onStartSettled={(ref) =>
            setStarted((previous) =>
              previous?.connection.ref === ref ? { ...previous, settled: true } : previous
            )
          }
          onEnded={(message) => {
            setShownRef(null);
            setNotice({ address, value: message });
          }}
          onCancelled={(label) => {
            onOpenChange(false);
            toast.success(`Approval for ${label} was cancelled.`);
          }}
          onClose={() => onOpenChange(false)}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

interface ConnectCommunityBodyProps {
  authority: ConfirmedCommunityAuthority | null;
  /** The connection on screen, or `null` for the form. */
  connection: CommunityConnectionDescriptor | null;
  check: CommunityApprovalCheck;
  approvalUrl: string | undefined;
  notice: string;
  installName: string;
  onStarted: (result: CommunityConnectionStartResponse) => void;
  /** The list has been re-read since that start. */
  onStartSettled: (ref: string) => void;
  /** A connection needing reconnection was removed; back to the form, saying so. */
  onEnded: (message: string) => void;
  /** A wait was cancelled; the dialog closes. */
  onCancelled: (label: string) => void;
  onClose: () => void;
}

/**
 * The dialog's inside. Mounted only while the dialog is open, so the form's
 * fields and any failed attempt start fresh on every opening.
 */
function ConnectCommunityBody({
  authority,
  connection,
  check,
  approvalUrl,
  notice,
  installName: defaultInstallName,
  onStarted,
  onStartSettled,
  onEnded,
  onCancelled,
  onClose,
}: ConnectCommunityBodyProps) {
  const transport = useTransport();
  const client = useQueryClient();
  const id = useId();
  const [url, setUrl] = useState('');
  const [installName, setInstallName] = useState(defaultInstallName);
  const addressInput = useRef<HTMLInputElement>(null);
  const approvalLink = useRef<HTMLAnchorElement>(null);
  const view = connection === null ? 'form' : connection.status;
  const previousView = useRef(view);

  // Focus follows the one next step: the approval link once a wait begins,
  // the address once the dialog is back on the form.
  useEffect(() => {
    const from = previousView.current;
    previousView.current = view;
    if (from === view) return;
    if (view === 'form') addressInput.current?.focus();
    else if (view === 'pending') approvalLink.current?.focus();
  }, [view]);

  const start = useMutation({
    mutationFn: async (address: string) => {
      if (!authority || !isCommunityAuthorityCurrent(authority))
        throw new Error('Community owner is still loading.');
      const result = await transport.startCommunityConnection({
        url: address,
        installName: installName.trim(),
      });
      if (!isCommunityAuthorityCurrent(authority)) throw new Error('Community owner changed.');
      return result;
    },
    onSuccess: async (result) => {
      setUrl('');
      onStarted(result);
      if (authority)
        await client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
      onStartSettled(result.connection.ref);
    },
  });
  const end = useEndCommunityConnection();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !installName.trim() || start.isPending) return;
    start.mutate(url.trim());
  }

  function endConnection(ending: CommunityConnectionDescriptor) {
    end.mutate(ending, {
      onSuccess: ({ remoteRevoked }) => {
        if (ending.status === 'pending') onCancelled(ending.label);
        else
          onEnded(
            remoteRevoked
              ? `${ending.label} is disconnected. Connect again to continue.`
              : unconfirmedDisconnectMessage(ending.label)
          );
      },
      // Ending can erase local proof even when the Community cannot answer.
      onSettled: () => {
        if (authority)
          void client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
      },
    });
  }

  // Always in the tree, so a notice that arrives later is still announced;
  // it only takes space once it has something to say.
  const status = (
    <p
      role="status"
      aria-live="polite"
      className={notice ? 'text-muted-foreground text-sm' : 'sr-only'}
    >
      {notice}
    </p>
  );

  if (connection === null)
    return (
      <form onSubmit={submit}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Connect a community</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Bring a community’s channels into this app, so you and your agents can talk there. You
            approve it on the community’s own site.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 py-4">
          {status}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>Community address</Label>
            <Input
              ref={addressInput}
              id={`${id}-url`}
              type="url"
              inputMode="url"
              placeholder="https://spaces.example.com/acme"
              aria-describedby={`${id}-url-hint`}
              required
              autoComplete="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={start.isPending || !authority}
            />
            <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
              Its full link or its short address both work.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Name for this installation</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={120}
              aria-describedby={`${id}-name-hint`}
              value={installName}
              onChange={(event) => setInstallName(event.target.value)}
              disabled={start.isPending || !authority}
            />
            <p id={`${id}-name-hint`} className="text-muted-foreground text-xs">
              What the community calls this DorkOS.
            </p>
          </div>
          {start.error && (
            <p role="alert" className="text-destructive text-sm">
              {startErrorMessage(start.error, start.variables)}
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={start.isPending || !authority || !url.trim() || !installName.trim()}
          >
            {start.isPending ? 'Connecting…' : 'Connect community'}
          </Button>
        </ResponsiveDialogFooter>
      </form>
    );

  const origin = (
    <p className="text-muted-foreground text-xs break-all">{connection.pinnedOrigin}</p>
  );

  if (connection.status === 'reconnect-required')
    return (
      <>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Reconnect {connection.label}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            This DorkOS can no longer reach {connection.label}’s channels. Disconnect here, then
            connect again.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3 py-4">
          {origin}
          {end.isError && (
            <p role="alert" className="text-destructive text-sm">
              Couldn’t disconnect. Check that DorkOS is running, then try again.
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={end.isPending} onClick={() => endConnection(connection)}>
            {end.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </ResponsiveDialogFooter>
      </>
    );

  // Pending. (A connected one closes the dialog before it is drawn for long.)
  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Approve on {connection.label}</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          {connection.label} asks you to approve this DorkOS on its own site. This moves on by
          itself once you do.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="space-y-3 py-4">
        {origin}
        {status}
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Waiting for your approval
        </p>
        {approvalUrl ? (
          <Button asChild>
            <a ref={approvalLink} href={approvalUrl} target="_blank" rel="noopener noreferrer">
              Open {connection.label} to approve
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">
            Approve in the community tab you opened. If you closed it, cancel and connect again.
          </p>
        )}
        {(end.isError || Boolean(check.error)) && (
          <div role="alert" className="space-y-2 text-sm">
            <p>
              {end.isError
                ? 'Couldn’t confirm cancellation. Refresh to check where it stands.'
                : 'Couldn’t check approval. Try again.'}
            </p>
            {!end.isError && (
              <Button size="sm" variant="outline" onClick={check.retry} disabled={check.isFetching}>
                Check approval
              </Button>
            )}
          </div>
        )}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="outline"
          disabled={end.isPending}
          onClick={() => endConnection(connection)}
        >
          {end.isPending ? 'Cancelling…' : 'Cancel approval'}
        </Button>
      </ResponsiveDialogFooter>
    </>
  );
}
