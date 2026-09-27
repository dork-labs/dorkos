import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ConnectorAppAction } from '@dorkos/shared/connector-resource-schemas';
import { useConnectorAppActions } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
  STATUS_TONE_SURFACE,
} from '@/layers/shared/ui';
import type { CardAccessLevel } from '../lib/access-card-selection';
import {
  BUCKET_LIMIT,
  actionBuckets,
  actionKind,
  examplePhrase,
  offersReadWrite,
  plainActionName,
  type ActionKind,
} from '../lib/app-actions';
import { LEVEL_LABELS } from './access/access-labels';

/** Props for {@link AppActions}. */
export interface AppActionsProps {
  /** The app's service id, e.g. `gmail`. */
  toolkit: string;
  /** The app's display name, e.g. "Gmail". */
  appName: string;
  /** The way that reaches the app, or `null` when none is set up yet. */
  providerInstanceId: string | null;
  /**
   * The level picked in "Who can use it", or `null` when there is none (before
   * the app is connected, or while agents hold different levels). With a
   * level, the section shows what that level lets agents do.
   */
  level: CardAccessLevel | null;
}

const KIND_LABELS: Record<ActionKind, string> = { look: 'Look', change: 'Change' };

/**
 * What an app lets agents do (design record `connection-app-details` §5):
 * a Look bucket and a Change bucket, tied to the access level, with the full
 * list one tap away. Read on demand when it first shows, then kept.
 */
export function AppActions({ toolkit, appName, providerInstanceId, level }: AppActionsProps) {
  const headingId = useId();
  const actions = useConnectorAppActions(toolkit, providerInstanceId);
  const listed = actions.data?.status === 'listed' ? actions.data : null;
  const heading =
    listed && level
      ? `With “${LEVEL_LABELS[level]}”, agents can`
      : `What agents can do in ${appName}`;

  let body: ReactNode;
  if (!providerInstanceId || notSetUp(actions.error)) {
    body = (
      <p className="text-muted-foreground text-sm">
        You’ll see what agents can do in {appName} once a way to reach it is set up.
      </p>
    );
  } else if (actions.isPending) {
    body = (
      <>
        <Skeleton className="h-16 rounded-lg" />
        <span className="sr-only">Loading what agents can do</span>
      </>
    );
  } else if (actions.isError) {
    body = (
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
        Couldn’t load what agents can do in {appName}.
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => void actions.refetch()}
          disabled={actions.isFetching}
        >
          Try again
        </Button>
      </p>
    );
  } else if (!listed) {
    body = (
      <p className="text-muted-foreground text-sm">
        DorkOS can’t list {appName}’s actions, so everything agents do in it counts as a change.
      </p>
    );
  } else {
    body = (
      <ListedActions
        actions={listed.actions}
        complete={listed.complete}
        toolkit={toolkit}
        appName={appName}
        level={level}
      />
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2.5" data-testid="app-actions">
      <p id={headingId} className="text-muted-foreground text-xs font-medium">
        {heading}
      </p>
      {body}
    </section>
  );
}

/** True when the way named is not set up (any more): a quiet state, not a failure. */
function notSetUp(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'provider_not_found'
  );
}

function ListedActions({
  actions,
  complete,
  toolkit,
  appName,
  level,
}: {
  actions: ConnectorAppAction[];
  complete: boolean;
  toolkit: string;
  appName: string;
  level: CardAccessLevel | null;
}) {
  if (actions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{appName} has no actions agents can use.</p>
    );
  }
  const buckets = actionBuckets(actions, level);
  const outside = buckets.outsideLevels;
  const notes: string[] = [];
  if (level === 'read-write' && buckets.change.length > 0) {
    notes.push('Pick “Read” and only Look stays.');
  }
  if (level === 'read' && buckets.addedByReadWrite.length > 0) {
    notes.push(
      `Pick “Read and write” to also let agents ${examplePhrase(buckets.addedByReadWrite, toolkit)}.`
    );
  }
  if (level !== null && outside.length > 0) {
    const plural = outside.length > 1;
    notes.push(
      `${upperFirst(examplePhrase(outside, toolkit))} ${plural ? 'aren’t' : 'isn’t'} part of ${
        offersReadWrite(actions) ? 'either level' : '“Read”'
      }. To allow ${plural ? 'them' : 'it'}, choose exact actions.`
    );
  }
  if (!complete) {
    notes.push(`Showing the first ${actions.length}. ${appName} has more than DorkOS can list.`);
  }

  return (
    <div className="space-y-3">
      {buckets.look.length === 0 && buckets.change.length === 0 ? (
        <p className="text-sm">Nothing at this level.</p>
      ) : (
        <>
          <Bucket kind="look" actions={buckets.look} toolkit={toolkit} />
          <Bucket kind="change" actions={buckets.change} toolkit={toolkit} />
        </>
      )}
      {notes.map((note) => (
        <p key={note} className="text-muted-foreground text-xs">
          {note}
        </p>
      ))}
      <AllActions actions={actions} complete={complete} toolkit={toolkit} />
    </div>
  );
}

/** One bucket: its name and its main few actions as chips. */
function Bucket({
  kind,
  actions,
  toolkit,
}: {
  kind: ActionKind;
  actions: ConnectorAppAction[];
  toolkit: string;
}) {
  if (actions.length === 0) return null;
  const shown = actions.slice(0, BUCKET_LIMIT);
  const more = actions.length - shown.length;
  return (
    <div className="space-y-1.5" data-testid={`app-actions-${kind}`}>
      <p className="text-sm font-medium">{KIND_LABELS[kind]}</p>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((action) => (
          <li
            key={action.operationSlug}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs',
              kind === 'look' ? 'bg-muted text-foreground' : STATUS_TONE_SURFACE.warning
            )}
          >
            {plainActionName(action, toolkit)}
          </li>
        ))}
        {more > 0 && <li className="text-muted-foreground px-1 py-0.5 text-xs">+{more} more</li>}
      </ul>
    </div>
  );
}

/** "See all N actions": every action, each tagged Look or Change. */
function AllActions({
  actions,
  complete,
  toolkit,
}: {
  actions: ConnectorAppAction[];
  complete: boolean;
  toolkit: string;
}) {
  const count = `${actions.length} ${actions.length === 1 ? 'action' : 'actions'}`;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/all text-primary focus-ring flex items-center gap-0.5 rounded-sm text-xs font-medium hover:underline">
        {complete ? `See all ${count}` : `See the first ${count}`}
        <ChevronRight
          className="size-3.5 transition-transform group-data-[state=open]/all:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul
          className="border-border mt-2 max-h-72 divide-y overflow-y-auto rounded-lg border"
          data-testid="app-actions-all"
        >
          {actions.map((action) => {
            const kind = actionKind(action.capabilityClassification);
            return (
              <li
                key={action.operationSlug}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">{plainActionName(action, toolkit)}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0 text-xs',
                    kind === 'look' ? 'bg-muted text-muted-foreground' : STATUS_TONE_SURFACE.warning
                  )}
                >
                  {KIND_LABELS[kind]}
                </span>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
