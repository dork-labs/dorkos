/**
 * The Obsidian embed's conversations roster, in the sidebar's own grammar.
 *
 * Same sessions, same groups and the same handlers the roster always had — the
 * chrome is now the shared primitives (`SectionHeader`, `SidebarRow` via
 * `SessionRowSidebar`, `useRovingFocus`) rather than a second idea about how a
 * sidebar looks. `SessionsView`, which this replaced HERE and only here, stays
 * exactly as it was for the Agent Hub's Sessions tab: that surface is a panel in
 * a page, not a sidebar, and re-skinning it is not this change (DOR-1080).
 *
 * **Zones stay out.** Heads up / Today / Library need router state — the active
 * route, deep links, `?prompt`/`seed` — that embedded mode does not have (spec
 * `sidebar-now-today-library`, Non-Goals). What the embed adopts is the row and
 * header grammar, which needs none of it.
 *
 * @module features/session-list/ui/EmbedSessionList
 */
import { motion } from 'motion/react';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { useRovingFocus } from '@/layers/shared/model';
import { ScrollArea, SectionHeader, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import { SessionRowSidebar } from '@/layers/entities/session';
import { FleetContextBar } from './FleetContextBar';
import { SessionListWarningNotice, warningKey } from './SessionListWarningNotice';

/** One time bucket of sessions, as `groupSessionsByTime` emits them. */
interface SessionGroup {
  /** The bucket's name — "Today", "Yesterday", "Last 7 days"… */
  label: string;
  /** Its sessions, newest first. */
  sessions: Session[];
}

/** Props for {@link EmbedSessionList}. */
export interface EmbedSessionListProps {
  /** The session currently on screen, or `null`. */
  activeSessionId: string | null;
  /** The roster, already bucketed by time. */
  groupedSessions: SessionGroup[];
  /**
   * Per-runtime listing degradations from the aggregated session list
   * (ADR-0310) — a runtime that failed or timed out contributed zero sessions.
   * Rendered as a quiet, non-blocking notice above the list.
   */
  warnings?: SessionListWarning[];
  /** Open a session. */
  onSessionClick: (sessionId: string) => void;
  /** Fork a session. When omitted, Fork is offered nowhere. */
  onForkSession?: (sessionId: string) => void;
  /** Rename a session. When omitted, Rename is offered nowhere. */
  onRenameSession?: (sessionId: string, title: string) => void;
}

/**
 * The roster: any listing warnings, the fleet's context health, then one
 * section per time bucket.
 *
 * @param props - The sessions, their grouping, and what the embed does with a
 *   click on one.
 */
export function EmbedSessionList({
  activeSessionId,
  groupedSessions,
  warnings = [],
  onSessionClick,
  onForkSession,
  onRenameSession,
}: EmbedSessionListProps) {
  return (
    <ScrollArea type="scroll" className="h-full" viewportClassName="[&>div]:!block">
      {warnings.length > 0 && (
        <div className="space-y-1 px-2 pt-2" data-testid="session-list-warnings">
          {warnings.map((warning) => (
            <SessionListWarningNotice key={warningKey(warning)} warning={warning} />
          ))}
        </div>
      )}
      {/* Fleet-level context health — complements the per-runtime warnings above
          and hides itself when there is nothing to report (spec §8b). */}
      <FleetContextBar />
      <motion.div layout>
        {groupedSessions.length > 0 ? (
          groupedSessions.map((group) => (
            <EmbedSessionGroup
              key={group.label}
              group={group}
              // A single bucket named "Today" is every session there is, so the
              // header would be labelling the whole list — the behaviour the
              // roster has always had, kept verbatim.
              showHeader={!(groupedSessions.length === 1 && group.label === 'Today')}
              activeSessionId={activeSessionId}
              onSessionClick={onSessionClick}
              {...(onForkSession ? { onForkSession } : {})}
              {...(onRenameSession ? { onRenameSession } : {})}
            />
          ))
        ) : (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sidebar-foreground/60 text-sm">No conversations yet</p>
          </div>
        )}
      </motion.div>
    </ScrollArea>
  );
}

/**
 * One time bucket: its header and its rows, as one composite widget.
 *
 * `useRovingFocus` is what makes it composite. A month of conversations is
 * fifty focusable rows and fifty "⋮" triggers, and `Tab` through them is a
 * hundred presses before the promo panel below; the section holds one stop and
 * the arrow keys move inside it (R2, spec §C).
 *
 * @param props - The bucket, whether to draw its header, and the handlers.
 */
function EmbedSessionGroup({
  group,
  showHeader,
  activeSessionId,
  onSessionClick,
  onForkSession,
  onRenameSession,
}: {
  group: SessionGroup;
  showHeader: boolean;
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
}) {
  // No `onCollapse`/`onExpand`: these sections are time buckets the roster
  // computes, not places the operator files things into, so there is nothing to
  // fold and `ArrowLeft`/`ArrowRight` correctly do nothing on the header.
  const roving = useRovingFocus();

  return (
    <SidebarGroup className="px-0" data-embed-session-group={group.label} {...roving}>
      {/* No `controlsId`: a header with nothing to collapse has no
          `aria-expanded` to pair it with, and `aria-controls` without one points
          at a relationship assistive tech has no way to act on. */}
      {showHeader && <SectionHeader label={group.label} />}
      <SidebarMenu>
        {group.sessions.map((session) => (
          <SessionRowSidebar
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={() => onSessionClick(session.id)}
            {...(onForkSession ? { onFork: onForkSession } : {})}
            {...(onRenameSession ? { onRename: onRenameSession } : {})}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
