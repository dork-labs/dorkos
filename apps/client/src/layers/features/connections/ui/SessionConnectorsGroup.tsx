import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, Plug, X } from 'lucide-react';
import type {
  PublicConnectedAccount,
  SessionConnectorAccountStatus,
  SessionConnectorWarning,
} from '@dorkos/shared/connector-provider';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from '@/layers/shared/ui';
import { getPlatform } from '@/layers/shared/lib';
import {
  useAttachSessionConnector,
  useConnectorAccounts,
  useDetachSessionConnector,
  useSessionConnectors,
} from '@/layers/entities/connectors';
import { accountDisplayName, FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/** Plain-language copy per null-branch reason — mirrors the server's reasons. */
const WARNING_COPY: Record<SessionConnectorWarning['reason'], string> = {
  expired: 'This account expired. Reconnect it under Connections.',
  revoked: 'This account was disconnected. Reconnect it under Connections.',
  unavailable: 'This account is not available right now.',
};

/**
 * The session view's Connections group — quiet until relevant: it renders
 * nothing until at least one account is connected or attached, so a cockpit
 * with no connectors carries no connector chrome. When live, it lists the
 * session's attached accounts with status and null-branch warnings, offers
 * attach (custody disclosure shown before the consent click) and one-action
 * detach, and links to /connections for management.
 *
 * @param props - The session whose connector surface to render.
 * @param props.sessionId - The active session id.
 */
export function SessionConnectorsGroup({ sessionId }: { sessionId: string }) {
  const session = useSessionConnectors(sessionId);
  const accounts = useConnectorAccounts();
  const navigate = useNavigate();
  const embedded = getPlatform().isEmbedded;

  const attached = session.data?.accounts ?? [];
  const warnings = session.data?.warnings ?? [];
  const connected = accounts.data?.accounts ?? [];

  // Calm Tech: no connected accounts anywhere and nothing attached — silence.
  if (attached.length === 0 && connected.length === 0) return null;

  const attachedIds = new Set(attached.map((row) => row.accountId as string));
  const attachable = connected.filter(
    (account) => !attachedIds.has(account.id as string) && account.status === 'active'
  );

  return (
    <section data-testid="session-connectors" className="min-w-0 space-y-0.5">
      <h3 className="text-muted-foreground flex items-center justify-between px-1 pb-1 text-xs font-medium tracking-wide uppercase">
        Connections
        {!embedded && (
          <button
            type="button"
            onClick={() => void navigate({ to: '/connections' })}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-3xs inline-flex items-center gap-0.5 rounded font-medium normal-case focus-visible:ring-2 focus-visible:outline-none"
          >
            Manage
            <ArrowUpRight className="size-3" aria-hidden />
          </button>
        )}
      </h3>

      {attached.length === 0 ? (
        <p className="text-muted-foreground px-1 py-0.5 text-xs">
          No accounts attached to this session.
        </p>
      ) : (
        attached.map((row) => (
          <AttachedAccountRow
            key={row.accountId}
            sessionId={sessionId}
            row={row}
            warning={warnings.find((w) => w.accountId === row.accountId)}
          />
        ))
      )}

      {attachable.length > 0 && <AttachPopover sessionId={sessionId} attachable={attachable} />}
    </section>
  );
}

/** One attached account: name, exposure state, warning, and detach. */
function AttachedAccountRow({
  sessionId,
  row,
  warning,
}: {
  sessionId: string;
  row: SessionConnectorAccountStatus;
  warning: SessionConnectorWarning | undefined;
}) {
  const detach = useDetachSessionConnector();
  const Icon = SERVICE_ICONS[row.toolkit.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
  const name = accountDisplayName(capitalize(row.toolkit), row.label);

  return (
    <div
      data-testid={`session-connector-${row.accountId}`}
      className="flex items-start gap-2 px-1 py-1 text-sm"
    >
      <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate">{name}</span>
          <Badge size="xs" variant={row.exposed ? 'secondary' : 'outline'}>
            {row.exposed ? 'tools on' : 'no tools'}
          </Badge>
        </div>
        {warning && (
          <p className="text-destructive mt-0.5 text-xs" role="alert">
            {WARNING_COPY[warning.reason]}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => detach.mutate({ sessionId, accountId: row.accountId as string })}
        disabled={detach.isPending}
        aria-label={`Detach ${name} from this session`}
        className="text-muted-foreground/60 hover:text-foreground focus-visible:ring-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The attach affordance: pick a connected account, read its custody
 * disclosure, then confirm — the consent click always comes after the
 * server's sentence is on screen.
 */
function AttachPopover({
  sessionId,
  attachable,
}: {
  sessionId: string;
  attachable: PublicConnectedAccount[];
}) {
  const attach = useAttachSessionConnector();
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState<PublicConnectedAccount | null>(null);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCandidate(null);
      attach.reset();
    }
  };

  return (
    <Popover open={open} onOpenChange={close}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground mt-1 gap-1.5 text-xs">
          <Plug className="size-3.5" aria-hidden />
          Attach account
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        {candidate === null ? (
          <ul className="space-y-0.5" aria-label="Connected accounts to attach">
            {attachable.map((account) => {
              const Icon = SERVICE_ICONS[account.toolkit.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
              return (
                <li key={account.id}>
                  <button
                    type="button"
                    onClick={() => setCandidate(account)}
                    className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    {accountDisplayName(capitalize(account.toolkit), account.label)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="space-y-2 p-1">
            {/* Consent point: the account's server-composed custody sentence,
                on screen before the Attach button can be pressed. */}
            <p data-testid="attach-disclosure" className="text-xs leading-relaxed">
              {candidate.disclosure}
            </p>
            {attach.data?.warning && (
              <p role="alert" className="text-destructive text-xs">
                Attached, but there is a problem. {WARNING_COPY[attach.data.warning.reason]}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCandidate(null)}>
                Back
              </Button>
              <Button
                size="sm"
                disabled={attach.isPending}
                onClick={() =>
                  attach.mutate(
                    { sessionId, accountId: candidate.id as string },
                    {
                      onSuccess: (result) => {
                        // Attached-but-unexposed stays visible (the warning
                        // renders above); a clean attach simply closes.
                        if (!result.warning) close(false);
                      },
                    }
                  )
                }
              >
                {attach.isPending ? 'Attaching…' : 'Attach'}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Title-case a toolkit slug for display beside its label. */
function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
