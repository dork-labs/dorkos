import type { ReactElement } from 'react';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/layers/shared/ui';
import type { TabIdentity } from '../lib/tab-identity';
import { TabIdentityIcon } from './TabIdentityIcon';
import { TabStatusMark } from './TabStatusMark';

/** How long the pointer rests on a tab before its card opens: a glance, not a flicker. */
const OPEN_DELAY_MS = 500;

/** "Last active 5m ago", "Last active just now". */
function lastActiveLine(at: number): string {
  const when = formatRelativeTime(new Date(at).toISOString());
  return `Last active ${when === 'Just now' ? 'just now' : when}`;
}

interface TabIdentityCardProps {
  /** The page to describe. */
  identity: TabIdentity;
  /** Extra classes for the card body. */
  className?: string;
}

/**
 * What a tab's hover card says: the full name the tab may have cut short,
 * where a chat came from, its status in one sentence, and when it was last
 * active. The content alone, so the Dev Playground can lay every state out
 * side by side.
 */
export function TabIdentityCard({ identity, className }: TabIdentityCardProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 text-xs', className)}>
      <div className="flex min-w-0 items-start gap-2">
        <TabIdentityIcon icon={identity.icon} className="mt-px" />
        <p className="min-w-0 font-medium break-words">
          {identity.primary}
          {identity.secondary && (
            <span className="text-muted-foreground font-normal"> · {identity.secondary}</span>
          )}
        </p>
      </div>
      {identity.origin && <p className="text-muted-foreground">{identity.origin}</p>}
      {identity.statusSentence && (
        <p className="flex items-center gap-1.5">
          <TabStatusMark identity={identity} />
          <span>{identity.statusSentence}</span>
        </p>
      )}
      {identity.lastActiveAt !== undefined && !Number.isNaN(identity.lastActiveAt) && (
        <p className="text-muted-foreground">{lastActiveLine(identity.lastActiveAt)}</p>
      )}
    </div>
  );
}

interface TabHoverCardProps {
  /** The page the tab points at. */
  identity: TabIdentity;
  /** The tab itself, which opens the card on hover. */
  children: ReactElement;
}

/**
 * A tab's hover card. Pointer only, and never the only place a fact lives:
 * the tab's accessible name already carries the status sentence.
 */
export function TabHoverCard({ identity, children }: TabHoverCardProps) {
  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={0}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-64 p-3">
        <TabIdentityCard identity={identity} />
      </HoverCardContent>
    </HoverCard>
  );
}
