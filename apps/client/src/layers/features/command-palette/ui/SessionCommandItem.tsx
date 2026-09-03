/**
 * One conversation as a command-palette row (design-decisions §3, §15).
 *
 * @module features/command-palette/ui/SessionCommandItem
 */
import { useMemo } from 'react';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
// A deep import into `shared/lib`, deliberately: the row-grammar module is not
// on that barrel (only `shared/ui/sidebar-row` consumed it when it landed), and
// re-typing the truncation budget here is the exact drift it exists to prevent.
// The same shape `entities/agent` uses to reach `resolve-agent-visual`.
import {
  ROW_SESSION_MARKER,
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
  composeRowLabel,
} from '@/layers/shared/lib/row-grammar';
import { useNow } from '@/layers/shared/model';
import { CommandItem, statusDotClass, type StatusSignal } from '@/layers/shared/ui';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { SessionOriginMark } from '@/layers/entities/session';
import { ArchivedMark } from './ArchivedMark';
import { paletteSessionKeywords, type PaletteSessionItem } from '../model/palette-sessions';

/** How often the row re-reads the clock for its relative timestamp. */
const CLOCK_TICK_MS = 60_000;

/** What a live row says beside its verb. */
export interface SessionCommandItemLive {
  /** The verb, from the shared ladder. `null` draws no second line. */
  verb: string | null;
  /** Which dot to draw — `working` breathes, `needs-you` holds still. */
  signal: StatusSignal;
}

/** Props for {@link SessionCommandItem}. */
export interface SessionCommandItemProps {
  /** The conversation this row opens. */
  item: PaletteSessionItem;
  /** Live state, when this row is in Continue. Absent for a row that is merely recent. */
  live?: SessionCommandItemLive;
  /**
   * Whether this row is the one cmdk has highlighted.
   *
   * It gates the shortcut hints. They are drawn on the highlighted row only —
   * a column of `↵ ⌘↵` down eight rows is noise, and the hint is only ever
   * about the row Enter would act on.
   */
  isSelected?: boolean;
  /** Open the conversation. */
  onSelect: () => void;
}

/** The relative timestamp the row carries in its meta slot. */
function TimeStamp({ lastActivityAt }: { lastActivityAt: string }) {
  const now = useNow(CLOCK_TICK_MS);
  const relative = useMemo(
    // A timestamp the browser cannot parse renders nothing rather than the
    // string "Invalid Date" — the same rule the sidebar's rows follow.
    () => (Number.isNaN(Date.parse(lastActivityAt)) ? null : formatRelativeTime(lastActivityAt)),
    // `now` is load-bearing and unused inside: it is the clock tick that makes
    // "30m ago" become "31m ago" without the row re-rendering for any other
    // reason. Same shape as the sidebar's own `useRelativeTime`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastActivityAt, now]
  );
  if (relative === null) return null;
  return <span className="text-muted-foreground text-2xs font-normal">{relative}</span>;
}

/**
 * A conversation in ⌘K: the owning agent's face, `Agent › title`, where it came
 * from, and when it was last touched.
 *
 * **The grammar is the sidebar's, to the character.** The 42% name cap, the
 * ~6-character title floor and the never-squeezed meta slot all come from
 * `row-grammar.ts`, so a conversation truncates the same way in the palette as
 * it does in Today (BC-25). The name repeats across rows on purpose: the same
 * agent with three conversations makes three rows, and the repetition is the
 * scan anchor (BC-23).
 *
 * **What it is NOT is `SidebarRow`.** That component renders a real `<button>`
 * inside a `<li>`, wrapped in a context menu with a "⋮" trigger of its own —
 * three focusable, right-clickable things inside what cmdk needs to be a single
 * `role="option"`. A palette row is selected by a listbox, not pressed; the
 * shared thing between the two surfaces is the grammar module, which is exactly
 * what stops a fourth truncation budget from being invented here.
 *
 * The second line appears only when there is live state to put on it, so height
 * carries meaning: a taller row is a working row (BC-24).
 *
 * **A conversation that left Today says so** ({@link ArchivedMark}) — the same
 * word an archived channel carries, because the reader's question is the same:
 * is this row part of what is happening now? A row with {@link
 * SessionCommandItemProps.live} state never carries it, whatever its stored
 * timestamp says. Liveness is a fact arriving this second and the timestamp is
 * a record of the last write; "working…" beside "Archived" would be the row
 * arguing with itself, and the fresher fact wins.
 */
export function SessionCommandItem({
  item,
  live,
  isSelected = false,
  onSelect,
}: SessionCommandItemProps) {
  const visual = useAgentVisual(item.agent, item.cwd ?? item.id);
  const label = composeRowLabel(item.who, item.title);
  const verb = live?.verb ?? null;

  return (
    <CommandItem
      // The id, not the title: two conversations may share a title, and cmdk
      // uses this value as the row's identity for selection.
      value={item.id}
      keywords={paletteSessionKeywords(item)}
      onSelect={onSelect}
      // The visible line truncates; this does not. A person who cannot tell two
      // rows apart at a glance can hover one and be told.
      title={label}
      className={cn('flex gap-2 py-1.5', verb !== null ? 'items-start' : 'items-center')}
    >
      <AgentAvatar
        color={visual.color}
        emoji={visual.emoji}
        size="xs"
        className={cn('shrink-0', verb !== null && 'mt-px')}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-slot="palette-session-line" className="flex w-full items-center gap-1.5 text-sm">
          {item.who ? (
            <>
              <span data-slot="palette-session-who" className={ROW_WHO_CLASS}>
                {item.who}
              </span>
              <span aria-hidden className="text-muted-foreground/60 flex-none">
                {ROW_SESSION_MARKER}
              </span>
            </>
          ) : null}
          <span data-slot="palette-session-title" className={ROW_TITLE_CLASS}>
            {item.title}
          </span>
          <span className={cn('flex items-center gap-1.5', ROW_TRAILING_CLASS)}>
            {/* In the meta slot rather than beside the title, so the title
                keeps its ~6-character floor and this is never squeezed away —
                the same budget the origin mark and the timestamp ride on. */}
            {item.archived && live === undefined && <ArchivedMark />}
            {/* The origin mark rides in the meta slot and never on the avatar —
                the avatar's corners belong to identity (BC-26). */}
            <SessionOriginMark
              origin={item.origin}
              label={item.originLabel}
              className="text-muted-foreground"
            />
            <TimeStamp lastActivityAt={item.lastActivityAt} />
            {isSelected && <ShortcutHints canStartNewSession={item.cwd !== null} />}
          </span>
        </span>
        {verb !== null && (
          <span className="text-muted-foreground flex items-center gap-1.5 text-2xs font-normal">
            {live !== undefined && (
              <span
                aria-hidden
                className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(live.signal))}
              />
            )}
            {verb}
          </span>
        )}
      </span>
    </CommandItem>
  );
}

/**
 * The two things Enter can do to this row, said on the row.
 *
 * Passive shortcut learning (§15's Raycast rule): the shortcut is shown where
 * the act is, so nobody has to be told it exists. `⌘↵` is offered only when the
 * conversation carries a directory — that is what a new session would be
 * started in, and a hint for something the row cannot do is worse than silence.
 */
function ShortcutHints({ canStartNewSession }: { canStartNewSession: boolean }) {
  return (
    <span aria-hidden className="text-muted-foreground flex items-center gap-1">
      <kbd className="bg-accent rounded px-1 py-0.5 font-mono text-3xs">↵</kbd>
      {canStartNewSession && (
        <kbd className="bg-accent rounded px-1 py-0.5 font-mono text-3xs">⌘↵</kbd>
      )}
    </span>
  );
}
