import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import {
  identityMarkFaces,
  RoomAvatar,
  RoomTitle,
  type IdentityMark,
} from '@/layers/entities/room';
import type {
  JumpBackInItem,
  JumpBackInRoomItem,
  JumpBackInSessionItem,
} from '@/layers/entities/recents';
import { JUMP_BACK_IN_LISTBOX_ID, jumpBackInRowId } from '../model/use-jump-back-in-popover';

/** Props for {@link JumpBackInPopover}. */
export interface JumpBackInPopoverProps {
  /** The threads to offer, most recently active first and already capped. */
  rows: JumpBackInItem[];
  /** Which row is highlighted — an index into {@link JumpBackInPopoverProps.rows}. */
  selectedIndex: number;
  /** Agent manifests keyed by projectPath, for the session rows' faces. */
  agents?: Record<string, AgentManifest | null>;
  /** Disambiguated agent display names keyed by projectPath. */
  displayNames?: Record<string, string>;
  /**
   * The mark a room row draws, from the one derivation every surface shares
   * (`roomIdentityMark`).
   *
   * Required, and deliberately not defaulted. Left to fall back on the room's
   * own roster, a direct message draws a letter disc where the sidebar draws
   * the agent's face — the shipped version of this component did exactly that,
   * re-opening DOR-582 on the surface sitting beside the one that fixed it. A
   * caller that cannot answer this cannot draw these rows correctly.
   */
  visualOf: (room: RoomSummary) => IdentityMark;
  /** Open a thread. */
  onSelect: (item: JumpBackInItem) => void;
}

/** The one line a row shows under its name, when there is one. */
interface OptionShellProps {
  /** The mark at the head of the row — a face or a `#`. */
  mark: React.ReactNode;
  /** The thread's name. A node rather than a string so a room can bring its own. */
  label: React.ReactNode;
  /** The whole row in one line, for the tooltip. */
  title: string;
  /** One line about the last thing that happened, or `null` for no second line. */
  summary: string | null;
  /** When the thread was last active, ISO-8601. */
  lastActivityAt: string;
  /** Position in the list — its `id`, and what the highlight is compared against. */
  index: number;
  /** Whether this is the row Enter would open. */
  isSelected: boolean;
  /** Now, in epoch ms, so every row re-bases on one clock. */
  now: number;
  /** Open this thread. */
  onSelect: () => void;
}

/**
 * One row of the popover: a mark, a name with a relative time, and — only when
 * there is something honest to say — one line about what last happened.
 *
 * The same anatomy the sidebar's "Jump back in" rows draw, in the one shape a
 * listbox can hold. A sidebar row is a button you tab to; an option here is
 * never focusable, because the composer keeps the caret and publishes the
 * highlight as its `aria-activedescendant` — the pattern the `@` picker
 * established next door.
 */
function JumpBackInOptionShell({
  mark,
  label,
  title,
  summary,
  lastActivityAt,
  index,
  isSelected,
  now,
  onSelect,
}: OptionShellProps) {
  // A timestamp the browser cannot parse renders NOTHING rather than the string
  // "Invalid Date" — the same rule the sidebar row follows, and for the same
  // reason: a row that quietly drops its time is still a row you can open.
  // `now` is a dependency rather than an argument: the formatter reads the wall
  // clock itself, so the tick is what re-runs it.
  const relativeTime = useMemo(
    () => (Number.isNaN(Date.parse(lastActivityAt)) ? null : formatRelativeTime(lastActivityAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastActivityAt, now]
  );

  return (
    // No `tabIndex`, and no key handler: DOM focus never reaches this element.
    // The panel swallows mousedown so a click cannot steal the caret, and the
    // composer owns every key. Both a11y rules below assume something the
    // keyboard reaches directly; satisfying them here would ship a focus stop
    // nothing can land on, which reads as an affordance and is not one.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- option is never focusable by design; see above
    <div
      id={jumpBackInRowId(index)}
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected}
      title={title}
      onClick={onSelect}
      className="data-[selected=true]:bg-accent hover:bg-muted flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors duration-100"
    >
      {/* Nudged down so the mark reads as centred on the FIRST line rather than
          on a two-line block whose second line may not be there. */}
      <span className="mt-px flex shrink-0 items-center">{mark}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex w-full items-center gap-1.5">
          <span className="text-foreground min-w-0 flex-1 truncate text-sm">{label}</span>
          {relativeTime !== null && (
            <span className="text-muted-foreground/60 text-3xs shrink-0">{relativeTime}</span>
          )}
        </span>
        {summary !== null && (
          <span className="text-muted-foreground/70 text-2xs truncate">{summary}</span>
        )}
      </span>
    </div>
  );
}

/** A session row — the owning agent's face, the title, and the last thing said. */
function JumpBackInSessionOption({
  item,
  agent,
  displayName,
  index,
  isSelected,
  now,
  onSelect,
}: {
  item: JumpBackInSessionItem;
  agent: AgentManifest | null;
  displayName: string;
  index: number;
  isSelected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const visual = useAgentVisual(agent, item.session.cwd ?? displayName);

  return (
    <JumpBackInOptionShell
      mark={<AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />}
      label={item.name}
      title={`${displayName} · ${item.name}`}
      summary={item.summary}
      lastActivityAt={item.lastActivityAt}
      index={index}
      isSelected={isSelected}
      now={now}
      onSelect={onSelect}
    />
  );
}

/** A room row — a channel's `#` or a direct message's face, and its name. */
function JumpBackInRoomOption({
  item,
  visual,
  index,
  isSelected,
  now,
  onSelect,
}: {
  item: JumpBackInRoomItem;
  visual: IdentityMark;
  index: number;
  isSelected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <JumpBackInOptionShell
      // The fleet-resolved faces, exactly as the sidebar's row draws them: a
      // direct message's mark is its agent's own face, matched back to the
      // manifest through `agentRef`. The roster's own `AuthorRef.emoji` is a
      // render cache the server fills in for almost nobody, so falling back to
      // it draws a letter where a face belongs (DOR-582).
      mark={
        <RoomAvatar
          room={item.room}
          participants={item.room.participants}
          visuals={identityMarkFaces(visual)}
        />
      }
      label={<RoomTitle room={item.room} />}
      title={item.summary === null ? item.name : `${item.name} · ${item.summary}`}
      summary={item.summary}
      lastActivityAt={item.lastActivityAt}
      index={index}
      isSelected={isSelected}
      now={now}
      onSelect={onSelect}
    />
  );
}

/**
 * The last few threads you were in, floating over an empty composer.
 *
 * Presentational and complete: what to draw, which row is lit, and what a click
 * means all arrive as props, so the Dev Playground can show it without a fleet
 * and the room composer can host it in Phase 2 without changing it.
 *
 * Small on purpose. This is a glance back at what you were doing before you
 * start typing — not a second sidebar, and not somewhere to browse. It draws
 * whatever it is given, and the hook that feeds it caps the list.
 */
export function JumpBackInPopover({
  rows,
  selectedIndex,
  agents = {},
  displayNames = {},
  visualOf,
  onSelect,
}: JumpBackInPopoverProps) {
  // One clock for the whole panel rather than one subscription per row: every
  // relative time re-bases on the same minute boundary.
  const now = useNow(60_000);

  // Keep the highlighted row in view when the arrows walk past the fold, the
  // same way the `@` picker does. Optional-call because jsdom implements no
  // layout and therefore no `scrollIntoView`.
  useEffect(() => {
    document.getElementById(jumpBackInRowId(selectedIndex))?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="bg-popover max-h-80 overflow-hidden rounded-lg border shadow-lg"
      // Keeps the composer focused through a click on a row. Without it the
      // field blurs first, which takes the panel down — so the click lands on
      // nothing and the thread never opens. Invisible to jsdom, which runs no
      // focus/blur race at all.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        id={JUMP_BACK_IN_LISTBOX_ID}
        role="listbox"
        aria-label="Jump back in"
        className="max-h-72 overflow-y-auto p-1.5"
      >
        {rows.map((item, index) =>
          item.kind === 'session' ? (
            <JumpBackInSessionOption
              key={`session-${item.id}`}
              item={item}
              agent={(item.session.cwd && agents[item.session.cwd]) || null}
              displayName={
                (item.session.cwd && displayNames[item.session.cwd]) ||
                item.session.cwd?.split('/').pop() ||
                'Agent'
              }
              index={index}
              isSelected={index === selectedIndex}
              now={now}
              onSelect={() => onSelect(item)}
            />
          ) : (
            <JumpBackInRoomOption
              key={`room-${item.id}`}
              item={item}
              visual={visualOf(item.room)}
              index={index}
              isSelected={index === selectedIndex}
              now={now}
              onSelect={() => onSelect(item)}
            />
          )
        )}
      </div>
    </motion.div>
  );
}
