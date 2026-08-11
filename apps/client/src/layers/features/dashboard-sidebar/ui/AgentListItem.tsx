import { useCallback, useState } from 'react';
import { BellOff } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { SidebarRow } from '@/layers/shared/ui';
import { AgentIdentity, type AgentVisual } from '@/layers/entities/agent';
import { useAgentHottestStatus } from '@/layers/entities/session';
import { useLiveSessionCount } from '../model/use-live-sessions';
import { useAgentRowMenuNodes } from './AgentRowMenuItems';
import { AgentActivityBadge } from './AgentActivityBadge';
import { LiveSessionsChip, SessionSwitcher } from './SessionSwitcher';
import type { SortableBindings } from './dnd/SidebarDndPrimitives';

/**
 * How many concurrent sessions it takes before the row offers the switcher.
 *
 * Two, because one is not a choice. A single live session is already what
 * pressing the row gives you, and the activity dot already says it is live —
 * a chip there would be a door to a room the operator is standing in.
 */
const LIVE_CHIP_THRESHOLD = 2;

/**
 * The empty id list the roster's status hook is called with, hoisted so it is
 * one array rather than a fresh one per render.
 *
 * The row has no session list to give it — that was the panel's, and the panel
 * is gone — and it does not need one: `useAgentHottestStatus` matches the fleet
 * status fan-out by `cwd`, which is what let a COLLAPSED row light up even when
 * the panel existed.
 */
const EMPTY_SESSION_IDS: string[] = [];

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
  /** Open one of this agent's sessions — what the switcher's `↵` does. */
  onSessionClick: (sessionId: string) => void;
  /** Start a fresh conversation with this agent. */
  onNewSession: () => void;
  /** Drag bindings applied to the row's root when the sidebar drag layer is active. */
  sortable?: SortableBindings;
}

/**
 * One agent in the roster — a {@link SidebarRow} call site, plus the one thing
 * the row grammar has no slot for: the "N live" chip.
 *
 * - Click: opens the conversation you were having with this agent, or starts a
 *   fresh one when there is none (BC-34). It does not unfold, and it does not
 *   toggle — **an agent is a teammate, not a folder.**
 * - The "N live" chip (two or more concurrent sessions): opens the session
 *   switcher, where depth now lives (BC-35).
 * - Right-click / long-press / "⋮": the same menu, from one node list.
 *
 * **The inline three-session panel is gone.** It could show three of fourteen
 * sessions, said nothing about what any of them was doing, and turned the one
 * row an operator clicks most into a disclosure triangle.
 * {@link SessionSwitcher} replaces it: every session, grouped by whether it is
 * live, with the verbs the panel could never carry.
 */
export function AgentListItem({
  path,
  agent,
  displayName: displayNameProp,
  visual,
  isActive,
  isMuted = false,
  onSelect,
  onOpenProfile,
  onViewProfile,
  onRequestNewGroup,
  onSessionClick,
  onNewSession,
  sortable,
}: AgentListItemProps) {
  const displayName =
    displayNameProp ?? getAgentDisplayName(agent, path.split('/').pop() ?? 'Agent');
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Aggregate status across all sessions for the activity dot. The path enables
  // fleet-wide cwd matching: the row is handed no session list, but
  // `session_status` fan-outs carry each live session's cwd.
  const rawAgentStatus = useAgentHottestStatus(EMPTY_SESSION_IDS, path);
  const liveCount = useLiveSessionCount(path);
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
  // A muted agent asks for nothing, and a chip counting its live work would be
  // asking. The switcher stays reachable from ⌘K, which is a place the operator
  // went on purpose.
  const showChip = !isMuted && liveCount >= LIVE_CHIP_THRESHOLD;

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

  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);

  return (
    <>
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
        // the agent and opens its last conversation.
        glyphAction={faceControl}
        isActive={isActive}
        muted={isMuted}
        onSelect={onSelect}
        menuNodes={menuNodes}
        actionsLabel="Agent actions"
        drag={sortable}
        className="font-medium"
        trailing={
          <>
            {isMuted && (
              <BellOff className="text-sidebar-foreground/50 size-3" aria-label="Muted" />
            )}
            {/*
              No chip here: `trailingAction` below draws it, and reserves its own
              width inside this slot. The dot and the chip are still mutually
              exclusive — the chip carries a dot of its own, so showing both
              would say "working" twice in two vocabularies.
            */}
            {!showChip && (
              <AgentActivityBadge status={agentStatus.kind} label={agentStatus.label} />
            )}
          </>
        }
        // The row's own trailing satellite (DOR-1111). It replaces a hand-rolled
        // overlay this call site used to park in the `expansion` slot, which had
        // to guess the row's right gutter — and guessed it from the source
        // rather than the DOM, so the chip landed 20px inside its own
        // reservation and painted over the truncated agent name.
        //
        // The row now owns placement AND reservation: it draws `content` twice,
        // once invisibly inside `trailing` so the title ellipsizes before it
        // reaches the chip, once as the overlay. Which is also why the chip is a
        // plain span — the invisible copy lives inside the row's `<button>`, and
        // a focusable in there is a button nested in a button. The primitive
        // `console.error`s in development if that rule is broken.
        {...(showChip
          ? {
              trailingAction: {
                content: <LiveSessionsChip count={liveCount} />,
                onClick: openSwitcher,
                label: `${liveCount} live sessions — open the session switcher for ${displayName}`,
              },
            }
          : {})}
      />
      {/*
        Mounted while the chip is on offer, and kept mounted while the surface is
        closing — a switcher unmounted the instant it is dismissed skips its own
        exit animation. It costs nothing at rest: closed, it renders no portal
        and asks for no sessions, so the row still fetches nothing of its own.
      */}
      {(showChip || switcherOpen) && (
        <SessionSwitcher
          agentPath={path}
          agentName={displayName}
          agentVisual={visual}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          onSelectSession={onSessionClick}
          onNewSession={onNewSession}
        />
      )}
    </>
  );
}
