import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import type {
  SessionConnectorAccountStatus,
  SessionConnectorWarning,
} from '@dorkos/shared/connector-provider';
import { Badge } from '@/layers/shared/ui';
import { getPlatform } from '@/layers/shared/lib';
import { useSessionConnectors } from '@/layers/entities/connectors';
import { accountDisplayName, FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/** Plain-language copy for a connection that currently cannot execute. */
const WARNING_COPY: Record<SessionConnectorWarning['reason'], string> = {
  expired: 'This account expired. Reconnect it under Connections.',
  paused: 'This account is paused. Resume it under Connections.',
  revoked: 'This account was disconnected. Reconnect it under Connections.',
  unavailable: 'This account is not available right now.',
};

const ACCESS_COPY: Record<SessionConnectorAccountStatus['access'], string> = {
  inherited: 'Agent access',
  session_allowed: 'Allowed for session',
  session_blocked: 'Blocked for session',
  needs_reconciliation: 'Needs review',
};

/**
 * Read-only connector access summary for one session. Access changes happen in
 * Connections, where an owner reviews exact immutable operations for an agent.
 *
 * @param props - The session whose durable connector access state is rendered.
 * @param props.sessionId - The active session id.
 */
export function SessionConnectorsGroup({ sessionId }: { sessionId: string }) {
  const session = useSessionConnectors(sessionId);
  const navigate = useNavigate();
  const embedded = getPlatform().isEmbedded;
  const accounts = session.data?.accounts ?? [];
  const warnings = session.data?.warnings ?? [];

  if (accounts.length === 0) return null;

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
            Manage agent access
            <ArrowUpRight className="size-3" aria-hidden />
          </button>
        )}
      </h3>

      {accounts.map((row) => (
        <AccessRow
          key={row.accountId}
          row={row}
          warning={warnings.find((candidate) => candidate.accountId === row.accountId)}
        />
      ))}
      <p className="text-muted-foreground px-1 pt-1 text-xs">
        Session overrides stay in effect until an owner changes them. Agent access does not replace
        a session block.
      </p>
    </section>
  );
}

/** One durable connection access row. */
function AccessRow({
  row,
  warning,
}: {
  row: SessionConnectorAccountStatus;
  warning: SessionConnectorWarning | undefined;
}) {
  const Icon = SERVICE_ICONS[row.toolkit.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
  const name = accountDisplayName(capitalize(row.toolkit), row.label);
  const blocked = row.access === 'session_blocked' || row.access === 'needs_reconciliation';

  return (
    <div
      data-testid={`session-connector-${row.accountId}`}
      className="flex items-start gap-2 px-1 py-1 text-sm"
    >
      <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate">{name}</span>
          <Badge size="xs" variant={blocked ? 'outline' : 'secondary'}>
            {ACCESS_COPY[row.access]}
          </Badge>
        </div>
        {warning && (
          <p className="text-destructive mt-0.5 text-xs" role="alert">
            {WARNING_COPY[warning.reason]}
          </p>
        )}
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
