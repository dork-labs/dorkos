import { ChevronRight } from 'lucide-react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { ServiceMark, serviceLogo, type ServiceLogo } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';
import { Badge, Button, Spinner, STATUS_TONE_DOT } from '@/layers/shared/ui';
import type { AppRowAction, YourAppRow } from '../../lib/app-list';

/** What each row action is called on its button. */
const ACTION_LABELS: Record<AppRowAction, string> = {
  'sign-in-again': 'Sign in again',
  resume: 'Resume',
  cancel: 'Cancel',
  review: 'Review',
  fix: 'Fix',
};

/** The small "Chat" tag that marks a chat app; the only thing that sets one apart. */
function ChatTag() {
  return (
    <Badge size="xs" variant="secondary" className="shrink-0">
      Chat
    </Badge>
  );
}

/**
 * The shared shape of every row: the app's mark, its name (with the Chat tag
 * when it is one) and one plain line under it.
 */
function RowBody({
  name,
  iconKey,
  logo,
  detail,
  chat,
  deprecated = false,
  wrapDetail = false,
  detailClassName,
}: {
  name: string;
  iconKey: string;
  /** What the catalog says about the app's logo. */
  logo?: ServiceLogo;
  detail: string;
  chat: boolean;
  /** Marks a chat app DorkOS no longer offers. */
  deprecated?: boolean;
  /** Let the line wrap to two lines (a description) instead of cutting it off. */
  wrapDetail?: boolean;
  detailClassName?: string;
}) {
  return (
    <>
      <ServiceMark iconKey={iconKey} displayName={name} logo={logo} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {chat && <ChatTag />}
          {deprecated && (
            <Badge size="xs" variant="outline" tone="warning" className="shrink-0">
              Deprecated
            </Badge>
          )}
        </span>
        <span
          className={cn(
            'text-muted-foreground block text-xs',
            wrapDetail ? 'line-clamp-2' : 'truncate',
            detailClassName
          )}
        >
          {detail}
        </span>
      </span>
    </>
  );
}

interface YourAppRowViewProps {
  /** The row to draw. */
  row: YourAppRow;
  /** Open the app's side panel. */
  onOpen: (row: YourAppRow) => void;
  /** Run the row's one action (Sign in again, Resume, Cancel…). */
  onAction: (row: YourAppRow) => void;
  /** True while that action is running. */
  actionPending?: boolean;
}

/**
 * One row in "Yours". The row tells you the state; its right side is always
 * the one thing you can do next (design record §2): a broken row is amber and
 * offers "Sign in again", a paused one is greyed and offers "Resume", a
 * sign-in in progress offers "Cancel", a chat app with someone waiting says
 * how many. A healthy row shows only a quiet green dot, and only when the
 * server says agents can use it.
 *
 * The row itself opens the side panel; the action is its own button beside it.
 */
export function YourAppRowView({
  row,
  onOpen,
  onAction,
  actionPending = false,
}: YourAppRowViewProps) {
  const off = row.tone === 'off';
  return (
    <li
      data-testid={`app-row-${row.id}`}
      data-tone={row.tone}
      className={cn(
        'group/row flex items-center rounded-lg transition-colors',
        row.tone === 'broken'
          ? 'bg-status-warning-bg/70 hover:bg-status-warning-bg'
          : 'hover:bg-muted/50'
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="focus-ring flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left"
      >
        <span className={cn('flex min-w-0 flex-1 items-center gap-3', off && 'opacity-55')}>
          <RowBody
            name={row.name}
            iconKey={row.iconKey}
            logo={row.logo}
            detail={row.detail}
            chat={row.kind === 'chat'}
            deprecated={row.deprecated}
            // What broke is the one line worth reading in full.
            wrapDetail={row.tone === 'broken'}
            detailClassName={row.tone === 'broken' ? 'text-status-warning-fg' : undefined}
          />
        </span>
        {!row.action && <RowStatus row={row} />}
      </button>
      {row.action && (
        <div className="flex shrink-0 items-center pr-3">
          <Button
            size="sm"
            variant={row.tone === 'broken' ? 'default' : 'outline'}
            disabled={actionPending}
            onClick={() => onAction(row)}
            aria-label={`${ACTION_LABELS[row.action]}: ${row.name}`}
          >
            {actionPending && <Spinner size="xs" />}
            {ACTION_LABELS[row.action]}
          </Button>
        </div>
      )}
    </li>
  );
}

/** The quiet right side of a row with no action: a waiting count, a spinner, or a dot. */
function RowStatus({ row }: { row: YourAppRow }) {
  if (row.waiting > 0) {
    return (
      <Badge shape="pill" tone="warning" variant="outline" className="shrink-0">
        {row.waiting} waiting
      </Badge>
    );
  }
  if (row.tone === 'busy') {
    return <Spinner size="xs" className="text-muted-foreground shrink-0" />;
  }
  if (row.tone === 'ready') {
    return (
      <span className="flex shrink-0 items-center">
        <span className={cn('size-2 rounded-full', STATUS_TONE_DOT.success)} aria-hidden />
        <span className="sr-only">Connected</span>
      </span>
    );
  }
  return (
    <ChevronRight
      className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100"
      aria-hidden
    />
  );
}

interface CatalogAppRowViewProps {
  /** The app, as the catalog lists it. */
  service: ConnectorCatalogService;
  /** True when this row is for a chat app (shows the Chat tag). */
  chat: boolean;
  /** The row's one action word: "Connect", or "Set up" for developer tools. */
  actionLabel: string;
  /** Start connecting. Absent when the app can't be connected here right now. */
  onConnect?: (service: ConnectorCatalogService) => void;
  /** Said in place of the action when it can't be connected (e.g. "Off"). */
  unavailableLabel?: string;
}

/**
 * One row in "All apps": what agents can do with the app, and Connect. The
 * whole row is the button, so there is one target and one name for it.
 */
export function CatalogAppRowView({
  service,
  chat,
  actionLabel,
  onConnect,
  unavailableLabel,
}: CatalogAppRowViewProps) {
  const detail = service.description ?? defaultDescription(service);
  const body = (
    <RowBody
      name={service.displayName}
      iconKey={service.iconKey}
      logo={serviceLogo(service)}
      detail={detail}
      chat={chat}
      wrapDetail
    />
  );
  if (!onConnect) {
    return (
      <li
        data-testid={`catalog-app-${service.serviceSlug}`}
        className="flex min-h-14 items-center gap-3 px-3 py-2"
      >
        <span className="flex min-w-0 flex-1 items-center gap-3 opacity-55">{body}</span>
        <span className="text-muted-foreground shrink-0 text-xs">{unavailableLabel}</span>
      </li>
    );
  }
  return (
    <li data-testid={`catalog-app-${service.serviceSlug}`}>
      <button
        type="button"
        onClick={() => onConnect(service)}
        aria-label={`${actionLabel} ${service.displayName}`}
        className="group/row hover:bg-muted/50 focus-ring flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors"
      >
        {body}
        <span
          aria-hidden
          className="border-border bg-background group-hover/row:bg-muted shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium shadow-xs transition-colors"
        >
          {actionLabel}
        </span>
      </button>
    </li>
  );
}

/** A plain line for an app the live catalog lists without one of its own. */
function defaultDescription(service: ConnectorCatalogService): string {
  const chat = service.intents.some((intent) => intent.kind === 'messages');
  const account = service.intents.some((intent) => intent.kind === 'account');
  if (chat && account) return `Talk to your agents in ${service.displayName}, or let them use it.`;
  if (chat) return `Talk to your agents in ${service.displayName}.`;
  return `Let agents use your ${service.displayName} account.`;
}
