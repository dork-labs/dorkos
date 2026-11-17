import { useState } from 'react';
import {
  ArrowUpRight,
  Clock,
  Hand,
  MousePointer2,
  Pause,
  User,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  STATUS_DOT_PULSE,
  chipVariants,
} from '@/layers/shared/ui';
import type { BrowserPillState, BrowserStatusPillActions } from '../model/browser-pill-state';

/** Props for {@link BrowserStatusPill}. */
export interface BrowserStatusPillProps extends BrowserStatusPillActions {
  /** The pill's state. */
  state: BrowserPillState;
  /** The agent's name, or null when the chat has none to show. */
  agentName: string | null;
  /** Whether a browser action is running, which holds every button. */
  busy?: boolean;
  /** "Now", for how long ago an agent asked. Tests pass it; the app reads the clock on open. */
  now?: number;
}

/** One state's look and words. */
interface PillCopy {
  icon: LucideIcon;
  /** The pill's own word, 14 characters at most. */
  label: string;
  /** The sheet's title on a phone, when it says more than the label. */
  title?: string;
  /** The popover's lines; the first is the pill's accessible name too. */
  lines: string[];
  /** What the hidden status region says, in the words the panel always used. */
  status: string;
}

/**
 * A short, honest "how long ago" for the asking agent's request.
 *
 * @param askedAt - When the agent asked.
 * @param now - The current time.
 */
export function askedAgo(askedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(askedAt)) / 60_000));
  if (minutes < 1) return 'Asked just now.';
  if (minutes < 60) return `Asked ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
  const hours = Math.floor(minutes / 60);
  return `Asked ${hours} hour${hours === 1 ? '' : 's'} ago.`;
}

/** Words the pill says on its own, which an agent's name must not pass for. */
const PILL_WORDS = new Set([
  'agent',
  'the agent',
  'paused',
  'your turn',
  'you',
  'handed back',
  'only you',
  'in another chat',
  'waiting',
]);

/**
 * The agent's name as the pill shows it, or null when there is none. Agents pick
 * their own names, so one that reads as the pill's own words ("You", "Your turn")
 * is put in quotes, and never passes for a state.
 *
 * @param agentName - The agent's name, or null.
 */
export function pillAgentName(agentName: string | null): string | null {
  const name = agentName?.trim();
  if (!name) return null;
  return PILL_WORDS.has(name.toLowerCase()) ? `“${name}”` : name;
}

/**
 * Each state's icon, label, popover lines and status words (spec §4).
 *
 * @param state - The pill's state.
 * @param agentName - The agent's name, or null.
 * @param now - The current time, for P3's "Asked … ago".
 */
export function browserPillCopy(
  state: BrowserPillState,
  agentName: string | null,
  now: number
): PillCopy {
  const named = pillAgentName(agentName);
  const agent = named ?? 'The agent';
  const using = [
    `${agent} is using this page.`,
    `${agent} stays on this page. Other windows are yours.`,
  ];
  switch (state.kind) {
    case 'driving':
      return { icon: Hand, label: named ?? 'Agent', lines: using, status: 'Connected' };
    case 'paused':
      return {
        icon: Pause,
        label: 'Paused',
        lines: [
          `${agent} won’t start anything new. It can still see this page.`,
          'An action already started may finish.',
        ],
        status: 'Agent paused',
      };
    case 'your-turn':
      return {
        icon: Hand,
        label: 'Your turn',
        lines: [
          // The site is the host DorkOS read from the page, never words the agent chose.
          state.reason === 'password'
            ? `${agent} needs you to sign in to ${state.site}.`
            : `${agent} needs you to finish a step on ${state.site}.`,
          askedAgo(state.askedAt, now),
          'It can’t see this page until you hand it back.',
        ],
        status: 'Waiting for you',
      };
    case 'you':
      return {
        icon: MousePointer2,
        label: 'You',
        lines: [`${agent} can’t see or use this page until you hand it back.`],
        status: `You have the page. ${agent} can’t see it until you hand it back.`,
      };
    case 'handed-back':
      return { icon: Hand, label: 'Handed back', lines: using, status: `Handed back to ${agent}.` };
    case 'only-you':
      return {
        icon: User,
        label: 'Only you',
        lines: ['Only you can use this page. Open it from an agent chat to share it.'],
        status: 'Only you can use this page.',
      };
    case 'elsewhere':
      return {
        icon: ArrowUpRight,
        label: 'In another chat',
        lines: ['This page is in another chat.'],
        status: 'This page is in another chat.',
      };
    case 'paused-sign-in':
      return {
        icon: Pause,
        label: 'Paused',
        lines: [`Paused while you sign in for another chat. ${agent} can still read this page.`],
        status: 'Agent paused',
      };
    case 'waiting':
      return {
        icon: Clock,
        label: 'Waiting',
        title: 'Waiting for a page',
        lines: [`${agent} hasn’t opened a page yet. It shows here when it does.`],
        status: 'Waiting for a page',
      };
  }
}

/**
 * The browser chrome's status pill: who has the page right now, and the agent
 * controls (Take over, Pause, Resume, Hand back) in its popover, which becomes a
 * bottom sheet on a phone. Its width is reserved, so the address field beside it
 * never moves when the state changes. Below 480px of chrome it shows its icon
 * alone, except "Your turn", the one orange pill, which always says it.
 *
 * A hidden status region keeps saying the panel's status words, so a change that
 * arrives on its own is announced without moving focus.
 */
export function BrowserStatusPill({
  state,
  agentName,
  busy = false,
  now,
  ...actions
}: BrowserStatusPillProps) {
  const [open, setOpen] = useState(false);
  // Read when the popover opens: "Asked … ago" only shows inside it.
  const [openedAt, setOpenedAt] = useState(0);
  const onOpenChange = (next: boolean) => {
    if (next) setOpenedAt(Date.now());
    setOpen(next);
  };
  const copy = browserPillCopy(state, agentName, now ?? openedAt);
  const yourTurn = state.kind === 'your-turn';
  const agent = pillAgentName(agentName) ?? 'the agent';
  const run = (action: (() => void) | undefined) =>
    action &&
    (() => {
      setOpen(false);
      action();
    });
  const buttons = pillButtons(state, agent, actions);
  return (
    <>
      <span role="status" className="sr-only">
        {copy.status}
      </span>
      <ResponsivePopover open={open} onOpenChange={onOpenChange}>
        <ResponsivePopoverTrigger asChild>
          <button
            type="button"
            data-slot="browser-status-pill"
            data-state-kind={state.kind}
            aria-label={copy.lines[0]}
            className={cn(
              chipVariants({ size: 'sm' }),
              // Reserved: the address field never moves when the words change.
              'w-32 justify-start',
              !yourTurn && '@max-[479px]/browser-chrome:w-auto @max-[479px]/browser-chrome:px-2',
              // Orange means "this is about you": only Your turn wears it.
              yourTurn && 'bg-brand/15 text-foreground hover:bg-brand/25'
            )}
          >
            <copy.icon aria-hidden className={cn(yourTurn && 'text-brand')} />
            {state.kind === 'driving' && (
              <span
                aria-hidden
                data-slot="browser-status-pill-live"
                className={cn('bg-status-success size-1.5 shrink-0 rounded-full', STATUS_DOT_PULSE)}
              />
            )}
            <span
              className={cn('min-w-0 truncate', !yourTurn && '@max-[479px]/browser-chrome:sr-only')}
            >
              {copy.label}
            </span>
          </button>
        </ResponsivePopoverTrigger>
        <ResponsivePopoverContent align="end" className="w-72 space-y-3 p-3 text-sm">
          {/* The sheet's body already has its inset, so the title takes none of its own. */}
          <ResponsivePopoverTitle headerClassName="px-0">
            {copy.title ?? copy.label}
          </ResponsivePopoverTitle>
          <div className="space-y-1">
            {copy.lines.map((line, index) => (
              <p key={line} className={cn(index > 0 && 'text-muted-foreground')}>
                {line}
              </p>
            ))}
          </div>
          {buttons.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {buttons.map((button, index) => (
                <Button
                  key={button.label}
                  size="sm"
                  variant={index === 0 ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={run(button.action)}
                >
                  {button.label}
                </Button>
              ))}
            </div>
          )}
        </ResponsivePopoverContent>
      </ResponsivePopover>
    </>
  );
}

/** The popover's buttons for a state, primary first; a state without a handler drops it. */
function pillButtons(
  state: BrowserPillState,
  agent: string,
  actions: BrowserStatusPillActions
): { label: string; action: () => void }[] {
  const all: { label: string; action?: () => void }[] =
    state.kind === 'driving' || state.kind === 'handed-back'
      ? [
          { label: 'Take over', action: actions.onTakeOver },
          { label: 'Pause agent', action: actions.onPause },
        ]
      : state.kind === 'paused'
        ? [
            { label: 'Resume agent', action: actions.onResume },
            { label: 'Take over', action: actions.onTakeOver },
          ]
        : state.kind === 'your-turn'
          ? [
              { label: `Hand back to ${agent}`, action: actions.onHandBack },
              { label: 'See the request', action: actions.onSeeRequest },
            ]
          : state.kind === 'you'
            ? [{ label: `Hand back to ${agent}`, action: actions.onHandBack }]
            : state.kind === 'paused-sign-in'
              ? [{ label: 'Show the sign-in', action: actions.onShowSignIn }]
              : [];
  return all.filter((button): button is { label: string; action: () => void } => !!button.action);
}
