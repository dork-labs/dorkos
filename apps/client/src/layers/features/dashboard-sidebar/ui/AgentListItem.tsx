import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence, type Variants } from 'motion/react';
import { Plus, BellOff } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { SidebarRow } from '@/layers/shared/ui';
import { AgentIdentity, type AgentVisual } from '@/layers/entities/agent';
import {
  useAgentHottestStatus,
  SessionRow,
  partitionSessionsByOrigin,
} from '@/layers/entities/session';
import { useAgentRowMenuNodes } from './AgentRowMenuItems';
import { AgentActivityBadge } from './AgentActivityBadge';
import type { SortableBindings } from './dnd/SidebarDndPrimitives';

/** Maximum sessions shown in the expanded agent preview. */
const MAX_PREVIEW_SESSIONS = 3;

// ── Expand/collapse orchestration ──
// Panel is always-mounted (height driven by variants); rows use AnimatePresence
// so they animate on mount whether they arrive during expansion or load late.

/** Outer wrapper — springs the height open/closed. */
const panelVariants: Variants = {
  expanded: {
    height: 'auto',
    transition: { type: 'spring', stiffness: 500, damping: 35, mass: 0.8 },
  },
  collapsed: {
    height: 0,
    transition: { type: 'spring', stiffness: 600, damping: 40, mass: 0.8 },
  },
};

/** Delay before the first row starts animating (seconds). */
const ROW_INITIAL_DELAY = 0.06;
/** Stagger between consecutive rows (seconds). */
const ROW_STAGGER = 0.04;

interface AgentListItemProps {
  path: string;
  agent: AgentManifest | null;
  /** Disambiguated display name (computed by parent to resolve duplicates). */
  displayName?: string;
  /**
   * The agent's face and colour, resolved by the sidebar's item view model.
   *
   * Passed in rather than resolved here so one layer owns every face the sidebar
   * draws — a direct message has to resolve the same agent's face from a room's
   * roster, and the two must agree (sidebar-groups §3.1).
   */
  visual: AgentVisual;
  isActive: boolean;
  isExpanded: boolean;
  /**
   * Whether this agent is muted — individually, or via its containing
   * group's mute lens (computed once by the orchestrator so every appearance
   * of the same agent, home row or pinned copy, renders muted identically).
   * Drops the activity badge and live-work border emphasis, dims the row,
   * and shows a small mute glyph after the name; the row stays in place and
   * clickable (DOR-339).
   */
  isMuted?: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  /** Open agent profile in the right panel hub. */
  onOpenProfile: () => void;
  /**
   * Open this agent's identity profile — the drawer, from its face.
   *
   * Absent when the mesh cannot name this agent to the roster (an id the drawer
   * would find nothing for), and the face is then plain, unclickable art rather
   * than a control that opens an empty panel.
   */
  onViewProfile?: () => void;
  /** Open the inline group-create flow, moving this agent into the new group on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
  /** Recent sessions for this agent (only needed when expanded). */
  sessions: Session[];
  /** True while the initial sessions fetch is in-flight (no cached data yet). */
  isLoadingSessions: boolean;
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  /** Fork a session by ID. When provided, fork option appears in session context menus. */
  onForkSession?: (sessionId: string) => void;
  /** Rename a session. When provided, rename option appears in session context menus. */
  onRenameSession?: (sessionId: string, title: string) => void;
  /** Drag bindings applied to the row's root when the sidebar drag layer is active. */
  sortable?: SortableBindings;
}

/**
 * One agent in the roster — a {@link SidebarRow} call site, with the live-work
 * border and the session preview panel it owns on top of it.
 *
 * - Click inactive agent: selects it and opens most recent session
 * - Click active agent: toggles expand/collapse
 * - Expanded view: recent sessions and new session action
 * - Right-click / long-press / "⋮": the same menu, from one node list
 *
 * **The preview panel stays until the session switcher lands.** The redesign
 * retires it (BC-34/BC-35 — an agent is a teammate, not a folder, and depth
 * moves to the switcher), but the switcher is a later phase and the sidebar's
 * rule is that a deletion happens in the phase that lands its replacement. This
 * phase lands the row's CHROME; the panel rides along, unchanged, as the row's
 * expansion slot.
 */
export function AgentListItem({
  path,
  agent,
  displayName: displayNameProp,
  visual,
  isActive,
  isExpanded,
  isMuted = false,
  onSelect,
  onToggleExpand,
  onOpenProfile,
  onViewProfile,
  onRequestNewGroup,
  sessions,
  isLoadingSessions,
  activeSessionId,
  onSessionClick,
  onNewSession,
  onForkSession,
  onRenameSession,
  sortable,
}: AgentListItemProps) {
  const displayName =
    displayNameProp ?? getAgentDisplayName(agent, path.split('/').pop() ?? 'Agent');
  // Conversations preview first, capped: automated sessions (agent/channel/task/
  // external origin) stay tucked behind the reveal row below (session-origin-legibility).
  const { conversations, automated } = useMemo(
    () => partitionSessionsByOrigin(sessions),
    [sessions]
  );
  const previewSessions = conversations.slice(0, MAX_PREVIEW_SESSIONS);
  const [automatedExpanded, setAutomatedExpanded] = useState(false);
  const showExpanded = isActive && isExpanded;

  // Aggregate status across all sessions for left-border indicator. The path
  // enables fleet-wide cwd matching: collapsed agents receive sessions=[] from
  // the parent, but session_status fan-outs carry each live session's cwd.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const rawAgentStatus = useAgentHottestStatus(sessionIds, path);
  // Mute suppresses every attention-driven emphasis at once: force the status
  // this row renders from to idle-shaped, regardless of the agent's real live
  // work, so the activity badge (which returns null for 'idle') drops with it
  // (DOR-339 decision 4).
  //
  // **The pulsing left border is gone, and its removal is the point.** "Working"
  // used to render five different ways in three colour spellings across this
  // cockpit, and this row carried two of them at once — an animated border AND a
  // badge, saying the same thing twice in two vocabularies. Live state now rides
  // the shared status tokens: the badge here, the dot on the face
  // (design-decisions §6, cleanups 1 and 3).
  const agentStatus = isMuted
    ? { kind: 'idle' as const, label: rawAgentStatus.label }
    : rawAgentStatus;

  const handleRowClick = useCallback(() => {
    if (isActive) {
      onToggleExpand();
    } else {
      onSelect();
    }
  }, [isActive, onSelect, onToggleExpand]);

  // The handler and its accessible name as ONE value, because they are one
  // decision: an agent the roster cannot name gets neither, and the face is
  // plain art rather than a control that opens an empty drawer.
  //
  // It reaches the ROW rather than the lockup. `AgentIdentity` would happily
  // make the face its own `<button>`, but the row around it is a `<button>` too
  // now, and a button inside a button is invalid HTML that assistive tech
  // announces unpredictably — so `SidebarRow` draws the control as an overlay
  // on the glyph's square, one level out, with the same target and the same
  // label (DOR-957's behaviour, kept exactly).
  const faceControl =
    onViewProfile !== undefined
      ? { onClick: onViewProfile, label: `Open ${displayName}’s profile` }
      : undefined;

  // "New group…" mounts an inline editor and carries `opensInput: true`, which
  // is what arms the shared surface's close-focus guard (DOR-329) — for both
  // menus at once, rather than once per Radix family as it used to be.
  const menuNodes = useAgentRowMenuNodes({
    path,
    onOpenProfile,
    onNewSession,
    onRequestNewGroup,
  });

  return (
    <SidebarRow
      dataSlot="agent-list-item"
      // The row's OWN verb, first — and it has to be spelled out because the
      // row's visible content is a face and a badge. The drag layer makes the
      // wrapper a button too, which takes its accessible name from its contents
      // in DOM order; with nothing here it opened with the FACE's label and
      // announced as "Open Scout's profile", which is the one thing pressing the
      // row does not do.
      srLabel={`Switch to ${displayName}`}
      // The lockup fills the TITLE slot rather than the glyph slot, and that is
      // deliberate: `AgentIdentity` is already `[face] [name]` — the row
      // grammar's own opening, drawn by the entity that owns how an agent
      // looks. Splitting it would mean drawing the face here and the name
      // there, and the two would drift the first time either moved.
      title={<AgentIdentity {...visual} name={displayName} size="xs" />}
      titleText={displayName}
      // The FACE opens the profile; the row keeps its own click, which selects
      // the agent and opens its last session.
      glyphAction={faceControl}
      isActive={isActive}
      muted={isMuted}
      onSelect={handleRowClick}
      menuNodes={menuNodes}
      actionsLabel="Agent actions"
      drag={sortable}
      className="font-medium"
      trailing={
        <>
          {isMuted && (
            <BellOff className="text-sidebar-foreground/50 size-3" aria-label="Muted" />
          )}
          <AgentActivityBadge status={agentStatus.kind} label={agentStatus.label} />
        </>
      }
      expansion={
        <motion.div
          animate={showExpanded ? 'expanded' : 'collapsed'}
          initial={false}
          variants={panelVariants}
          className={cn('overflow-hidden', !showExpanded && 'pointer-events-none')}
          aria-hidden={!showExpanded}
        >
          <div className="bg-sidebar-accent/40 space-y-0.5 py-1 pl-3">
            <AnimatePresence>
              {showExpanded && isLoadingSessions && previewSessions.length === 0 && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.2, delay: ROW_INITIAL_DELAY } }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                >
                  <div className="text-sidebar-foreground/40 px-2 py-1.5 text-[11px]">
                    <span className="animate-pulse">Loading&hellip;</span>
                  </div>
                </motion.div>
              )}

              {showExpanded &&
                !isLoadingSessions &&
                previewSessions.length === 0 &&
                automated.length === 0 && (
                  <motion.div
                    key="first-session"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: {
                        opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                        y: { type: 'spring', stiffness: 500, damping: 30 },
                        delay: ROW_INITIAL_DELAY,
                      },
                    }}
                    exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                  >
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                        #1
                      </span>
                      <span className="text-sidebar-foreground/50 text-[11px]">First session</span>
                    </div>
                  </motion.div>
                )}

              {showExpanded &&
                previewSessions.map((session, i) => (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: {
                        opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                        y: { type: 'spring', stiffness: 500, damping: 30 },
                        delay: ROW_INITIAL_DELAY + i * ROW_STAGGER,
                      },
                    }}
                    exit={{
                      opacity: 0,
                      y: -6,
                      transition: {
                        duration: 0.1,
                        delay: (previewSessions.length - 1 - i) * 0.025,
                      },
                    }}
                  >
                    <SessionRow
                      variant="compact"
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSessionClick(session.id)}
                      onFork={onForkSession}
                      onRename={onRenameSession}
                    />
                  </motion.div>
                ))}

              {showExpanded && (previewSessions.length > 0 || automated.length > 0) && (
                <motion.div
                  key="new-session-btn"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                      y: { type: 'spring', stiffness: 500, damping: 30 },
                      delay: ROW_INITIAL_DELAY + previewSessions.length * ROW_STAGGER,
                    },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewSession();
                    }}
                    className="text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-100"
                  >
                    <Plus className="size-(--size-icon-xs)" />
                    New session
                  </button>
                </motion.div>
              )}

              {showExpanded && automated.length > 0 && (
                <motion.div
                  key="automated-reveal"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                      y: { type: 'spring', stiffness: 500, damping: 30 },
                      delay: ROW_INITIAL_DELAY + (previewSessions.length + 1) * ROW_STAGGER,
                    },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAutomatedExpanded((prev) => !prev);
                    }}
                    aria-expanded={automatedExpanded}
                    className="text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-100"
                  >
                    {automatedExpanded ? 'Hide' : `+ ${automated.length} automated`}
                  </button>
                </motion.div>
              )}

              {showExpanded &&
                automatedExpanded &&
                automated.slice(0, MAX_PREVIEW_SESSIONS).map((session, i) => (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: {
                        opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                        y: { type: 'spring', stiffness: 500, damping: 30 },
                        delay: ROW_INITIAL_DELAY + i * ROW_STAGGER,
                      },
                    }}
                    exit={{
                      opacity: 0,
                      y: -6,
                      transition: { duration: 0.1 },
                    }}
                  >
                    <SessionRow
                      variant="compact"
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSessionClick(session.id)}
                      onFork={onForkSession}
                      onRename={onRenameSession}
                    />
                  </motion.div>
                ))}
            </AnimatePresence>
          </div>
        </motion.div>
      }
    />
  );
}
