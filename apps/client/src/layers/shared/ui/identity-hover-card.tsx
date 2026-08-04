/**
 * The compact card that opens over an identity — an avatar, a name, a
 * handle, and just enough context to place who or what this is.
 *
 * @module shared/ui/identity-hover-card
 */
import type * as React from 'react';
import { Bot, Send } from 'lucide-react';
import { formatDuration } from '../lib/format-duration';
import { initialOf } from '../lib/initial-of';
import { cn } from '../lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import { IdentityAvatar } from './identity-avatar';

/** How long the pointer has to sit on a trigger before the card opens. Radix's own default (700ms) reads as sluggish for something this small; this favours a quick glance. */
const OPEN_DELAY_MS = 300;

/** Where a human participant is posting from — mirrors {@link MentionPillProps.origin}. */
export type IdentityOrigin = 'local' | { platform: string };

/** What an agent identity adds to the card: how it runs, and whether it is working right now. */
export interface IdentityHoverCardAgentInfo {
  /** The runtime this agent runs on, e.g. `'Claude Code'`. Omitted chips are simply not drawn. */
  runtime?: string;
  /** The model this agent runs, e.g. `'Opus 4.8'`. */
  model?: string;
  /** Present while the agent has a turn in flight; absent otherwise. */
  working?: {
    /** The room it is working in, when that is worth naming. */
    room?: string;
    /** How long it has been working, in milliseconds. */
    forMs: number;
  };
}

/** The identity a hover card describes — everything it needs and nothing it has to fetch. */
export interface IdentityHoverCardDescriptor {
  /** What kind of identity this is. Drives the avatar's shape and fill, and which chips apply. */
  kind: 'human' | 'agent' | 'system';
  /** The name shown as the card's title. */
  displayName: string;
  /** The `@handle`, shown as a subtitle. Omitted entirely when there is none — never faked. */
  handle?: string;
  /** Identity colour. Agents fill their avatar with it; others tint. */
  color?: string;
  /** The identity's own emoji, when it has one. */
  emoji?: string;
  /** Where a human participant is posting from. Ignored for `agent`/`system`. */
  origin?: IdentityOrigin;
  /** Runtime, model, and live working state. Ignored for `human`/`system`. */
  agent?: IdentityHoverCardAgentInfo;
}

export interface IdentityHoverCardProps {
  /** The identity this card describes. */
  identity: IdentityHoverCardDescriptor;
  /** The element that opens the card on hover — wrapped in `asChild`, so it keeps its own tag. */
  children: React.ReactNode;
  /** Extra classes for the popover content. */
  className?: string;
}

/** One pill of context inside the card — a fact about the identity, not a control. */
function InfoChip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px]',
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * The compact identity card (design direction A): avatar and name up top,
 * `@handle` as its subtitle when there is one, a row of fact chips, and a
 * footer pinned under everything with a "View profile" affordance marked
 * **soon** — the click is deferred until there is a profile route to send it
 * to.
 *
 * **Touch has no long-press path in this slice.** Radix's `HoverCard` only
 * opens on pointer hover, so on a touch device this card simply never opens
 * — there is no tap-and-hold affordance here yet. The alternative (a
 * `Popover` driven by a manual long-press timer) is real work — its own
 * gesture, its own dismiss behaviour, its own conflict with scroll — and
 * belongs with the slice that actually wires this card onto a touch surface.
 * Scoped out here rather than half-built.
 *
 * Presentational: it renders the descriptor it is handed and composes
 * {@link IdentityAvatar}. The caller resolves `identity` from whatever
 * source it has — the mock data in the dev playground today, a room roster
 * or `AuthorRef` lookup in the slice that wires this on for real.
 */
function IdentityHoverCard({ identity, children, className }: IdentityHoverCardProps) {
  const { kind, displayName, handle, color, emoji, origin, agent } = identity;
  const avatarColor = color ?? 'var(--muted-foreground)';
  const isExternal = typeof origin === 'object' && origin !== null;

  return (
    <HoverCard openDelay={OPEN_DELAY_MS}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        data-slot="identity-hover-card"
        align="start"
        className={cn('flex w-64 flex-col gap-0 overflow-hidden p-0', className)}
      >
        <div className="flex items-center gap-3 p-3">
          <IdentityAvatar
            aria-hidden
            color={avatarColor}
            emoji={emoji}
            fallback={initialOf(displayName)}
            shape={kind === 'agent' ? 'square' : 'circle'}
            variant={kind === 'agent' ? 'fill' : 'tint'}
            badge={kind === 'agent' ? <Bot /> : isExternal ? <Send /> : undefined}
            size="md"
          />
          <div className="min-w-0">
            <p className="text-foreground truncate text-sm font-semibold">{displayName}</p>
            {handle && (
              <p className="text-muted-foreground truncate text-xs font-medium">@{handle}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 px-3 pb-3 empty:hidden">
          {kind === 'agent' && (agent?.runtime || agent?.model) && (
            <InfoChip>{[agent.runtime, agent.model].filter(Boolean).join(' · ')}</InfoChip>
          )}
          {kind === 'agent' && agent?.working && (
            <InfoChip className="bg-status-success-bg text-status-success-fg">
              <span
                aria-hidden
                className="bg-status-success relative inline-flex size-1.5 shrink-0 rounded-full"
              >
                <span className="bg-status-success absolute inset-0 animate-ping rounded-full opacity-75 motion-reduce:hidden" />
              </span>
              Working · {formatDuration(agent.working.forMs)}
            </InfoChip>
          )}
          {kind === 'human' && (
            <InfoChip>{isExternal ? origin.platform : 'On this machine'}</InfoChip>
          )}
        </div>

        <div className="border-border mt-auto flex items-center justify-between border-t px-3 py-2">
          <span className="text-brand text-xs font-medium">View profile</span>
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">soon</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export { IdentityHoverCard };
