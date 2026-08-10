/**
 * The whole sidebar, as `buildSidebarModel` decides it, across all four journeys.
 *
 * This page is the model's window. `buildSidebarModel` is pure and takes one
 * snapshot, so the entire panel can be looked at — every zone, every cap, every
 * rollup, in both themes — with no server, no agents on disk and no clock. The
 * four journey fixtures that drive the model's table tests drive these
 * showcases and `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`
 * as well, so what a reviewer looks at and what CI asserts are the same states
 * (spec `sidebar-now-today-library` §13, `contributing/sidebar-model.md`).
 *
 * **Every node says why it is there.** Each zone, section and row renders its
 * `reason` beside it — **every one of them, including the headerless bodies Now
 * and Today draw**, which have no header element to hang a chip off and so get
 * their own line. So "why is this row here?" is answered by looking rather than
 * by reading `rules/`. The chips can be turned off to see the panel as an
 * operator would.
 *
 * **The composition here is temporary; the primitives are not.** Rows are the
 * real `SidebarRow` and headers the real `SectionHeader` — nothing about a row's
 * chrome is re-drawn here. What this file does hold is the walk from
 * `SidebarModel` to those primitives, because P2's `SidebarZones` does not exist
 * yet. When it lands (task 2.1), this page renders that component and the walk
 * below is deleted rather than kept in parallel.
 *
 * **Deep imports on purpose.** `buildSidebarModel` and the fixtures are not on
 * the `features/dashboard-sidebar` barrel, and should not be: they are consumed
 * by the model's own tests and by this page, not by the app. The Dev Playground
 * has always reached past feature barrels for exactly this reason (see
 * `ToolShowcases`, `AdapterWizardShowcases`), which keeps a playground-only
 * symbol out of a public surface.
 *
 * @module dev/showcases/SidebarModelShowcases
 */
import { useId, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  Clock,
  CornerDownRight,
  Hash,
  Loader,
  MessageSquarePlus,
  Moon,
  Search,
  ShieldQuestion,
  Sparkles,
  Sun,
  UserPlus,
} from 'lucide-react';
import { cn, resolveAgentVisual } from '@/layers/shared/lib';
import {
  IdentityAvatar,
  ORIGIN_GLYPH,
  SectionHeader,
  SidebarMenu,
  SidebarRow,
  Switch,
  statusDotClass,
} from '@/layers/shared/ui';
import type {
  SidebarIconId,
  SidebarModel,
  SidebarOriginMark,
  SidebarRowModel,
  SidebarSectionModel,
  SidebarZoneModel,
} from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { SIDEBAR_FIXTURES } from '@/layers/features/dashboard-sidebar/model/fixtures';
import { anchorKey } from '@/layers/features/dashboard-sidebar/model/rules/targets';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';

/**
 * The visible panel width the redesign builds to (design-system §Sidebar).
 *
 * Spelled here rather than as `w-68` so the number a reviewer measures on this
 * page is the number the guide names, and a browser test can assert it.
 */
const PANEL_WIDTH = 272;

/** What each semantic icon id in the model is actually drawn as. */
const ICON: Record<SidebarIconId, typeof Bot> = {
  permission: ShieldQuestion,
  question: CircleHelp,
  error: AlertTriangle,
  idle: Clock,
  overflow: ChevronRight,
  working: Loader,
  automated: CalendarClock,
  digest: Sparkles,
  discovery: Search,
  'add-agent': UserPlus,
  'first-session': MessageSquarePlus,
  team: Hash,
  dorkbot: Bot,
  session: MessageSquarePlus,
};

/**
 * The mark that says where a conversation came from, per origin the model emits.
 *
 * A translation table rather than a direct index, because the two vocabularies
 * are not the same set: `ORIGIN_GLYPH` is keyed by `SessionOrigin`
 * (`task`, `channel`, `external`, …) while the model speaks in the marks a
 * reader sees (`timer`, `bridged`, …), and it carries a `thread` the session
 * vocabulary has no word for. `build-sidebar-model.ts` notes that the two
 * converge when `SidebarOriginMark` moves down beside the glyph registry; until
 * they do, the mapping is written out here rather than assumed.
 */
const ORIGIN_MARK: Record<SidebarOriginMark, (typeof ORIGIN_GLYPH)['room']> = {
  timer: ORIGIN_GLYPH.task,
  bridged: ORIGIN_GLYPH.channel,
  room: ORIGIN_GLYPH.room,
  agent: ORIGIN_GLYPH.agent,
  /** A reply hanging off a message — the one mark the session vocabulary lacks. */
  thread: CornerDownRight,
};

/**
 * One node's provenance, drawn where the node is.
 *
 * Always in the DOM, whether or not the chips are switched on: it is the handle
 * the browser test counts rows by, and a debug affordance that disappears when
 * it is turned off cannot prove every row carries one.
 *
 * @param reason - The `reason` the model stamped on the node.
 * @param show - Whether the chips are currently switched on.
 * @param className - Extra classes for the chip's own position.
 */
function ReasonChip({
  reason,
  show,
  className,
}: {
  reason: string;
  show: boolean;
  className?: string;
}) {
  return (
    <span
      data-slot="sidebar-model-reason"
      data-reason={reason}
      title={`reason: ${reason}`}
      className={cn(
        'text-sidebar-foreground/70 bg-sidebar/80 rounded px-1 font-mono text-[10px] leading-4',
        show ? 'inline-block' : 'sr-only',
        className
      )}
    >
      {reason}
    </span>
  );
}

/**
 * The mark at the head of a row, from the model's semantic glyph.
 *
 * Every face is drawn from a hash of the identity's own path or id — there is
 * no photo to fetch and no agent to look up, which is what keeps this page
 * working with no server behind it.
 *
 * @param row - The row whose glyph this is.
 * @param state - The snapshot the row came from, for display names.
 */
function RowGlyph({ row, state }: { row: SidebarRowModel; state: SidebarState }) {
  const { glyph, status } = row;

  if (glyph.kind === 'hash') {
    return <Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />;
  }
  if (glyph.kind === 'icon') {
    const Icon = ICON[glyph.icon];
    return <Icon aria-hidden className="text-sidebar-foreground/60 size-3.5" />;
  }
  if (glyph.kind === 'agent-avatar') {
    const visual = resolveAgentVisual({ id: glyph.agentPath });
    return (
      <IdentityAvatar
        kind="agent"
        size="xs"
        status={status}
        color={visual.color}
        emoji={visual.emoji}
        fallback={(state.displayNames[glyph.agentPath] ?? '?').slice(0, 1).toUpperCase()}
        className="size-[18px] text-[9px]"
      />
    );
  }
  if (glyph.kind === 'person-avatar') {
    return (
      <IdentityAvatar
        kind="human"
        size="xs"
        status={status}
        color={resolveAgentVisual({ id: glyph.memberId }).color}
        fallback={row.primary.slice(0, 1).toUpperCase()}
        className="size-[18px] text-[9px]"
      />
    );
  }
  return (
    <span className="flex -space-x-1">
      {glyph.memberIds.slice(0, 2).map((memberId) => (
        <IdentityAvatar
          key={memberId}
          kind="human"
          size="xs"
          color={resolveAgentVisual({ id: memberId }).color}
          fallback=" "
          className="size-3.5 text-[8px]"
        />
      ))}
    </span>
  );
}

/**
 * The numbered amber badge the `directed` tier draws, and the only mark either
 * unread tier is allowed (design-decisions §18).
 *
 * The class string is the cockpit's existing unread pill (`RoomRow`), not a new
 * one — the point of the page is to show what the sidebar draws, so an invented
 * badge here would be showing nothing.
 *
 * **axe cannot judge it, and that is expected.** A one-digit label trips
 * axe-core's "content is too short to determine if it is actual text" heuristic,
 * so every one of these lands in the run's `incomplete` bucket rather than its
 * violations. The browser spec asserts that they are the ONLY thing in there, so
 * the hole stays exactly this size.
 *
 * @param count - How many messages are addressed to you here.
 */
function DirectedBadge({ count }: { count: number | undefined }) {
  return (
    <span
      data-slot="sidebar-model-directed-badge"
      className="bg-brand/15 text-brand rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
      aria-label={`${count ?? 0} unread`}
    >
      {count}
    </span>
  );
}

/**
 * The trailing meta a row carries: its unread mark, its project, its origin.
 *
 * **The `activity` tier draws nothing here on purpose.** Bold label only — no
 * badge and no dot (design-decisions §18). The bold is the row's `emphasized`
 * prop; this slot stays empty, and a mark appearing here for an activity-tier
 * row is the regression to look for.
 *
 * @param row - The row whose trailing slot this is.
 */
function RowTrailing({ row }: { row: SidebarRowModel }) {
  const Origin = row.origin === undefined ? null : ORIGIN_MARK[row.origin];
  return (
    <>
      {/* `/70`, not `/60`. At 10px these are small text and owe 4.5:1; `/60`
          measured 4.21 on the active row's tint and 4.27 on the zone card, which
          the axe gate in `sidebar-model-showcase.spec.ts` failed on. The icons
          below stay at `/60` — they are graphics, not text, and owe 3:1. */}
      {row.projectLabel !== undefined && (
        <span className="text-sidebar-foreground/70 max-w-16 truncate text-[10px]">
          {row.projectLabel}
        </span>
      )}
      {row.liveCount !== undefined && (
        <span className="text-sidebar-foreground/70 text-[10px] tabular-nums">
          {row.liveCount} live
        </span>
      )}
      {Origin !== null && (
        <Origin
          aria-hidden
          className="text-sidebar-foreground/60 size-3"
          data-origin={row.origin}
          size={12}
        />
      )}
      {row.unread.tier === 'directed' && <DirectedBadge count={row.unread.count} />}
    </>
  );
}

/**
 * One row of the model, drawn by the sidebar's own row primitive.
 *
 * The mapping is the whole component, and it is the one BC-23 asks for: a row
 * with a `secondary` is a thread OF a place, so its `who` is set and the `›`
 * appears; a row without one is the place itself and takes the title slot
 * directly.
 *
 * @param row - The row to draw.
 * @param state - The snapshot it came from.
 * @param activeKey - The key of the row the operator is standing on, if any.
 * @param showReasons - Whether reason chips are switched on.
 */
function ModelRow({
  row,
  state,
  activeKey,
  showReasons,
}: {
  row: SidebarRowModel;
  state: SidebarState;
  activeKey: string | null;
  showReasons: boolean;
}) {
  return (
    <SidebarRow
      glyph={<RowGlyph row={row} state={state} />}
      who={row.secondary === undefined ? undefined : row.primary}
      title={row.secondary ?? row.primary}
      trailing={<RowTrailing row={row} />}
      reservesVerbLine={row.reservesVerbLine}
      preview={row.preview ?? null}
      isActive={row.key === activeKey}
      emphasized={row.unread.tier !== 'none'}
      muted={row.muted}
      dataSlot="sidebar-model-row"
      expansion={
        <ReasonChip reason={row.reason} show={showReasons} className="mb-0.5 ml-9 max-w-full" />
      }
    />
  );
}

/**
 * The part of a folded section's signal that is a MARK: how much is running in
 * it, and how many messages are addressed to you.
 *
 * **The `activity` tier is deliberately absent here.** It is a bold label and
 * nothing else — no badge, no dot (design-decisions §18) — so it cannot be a
 * mark in this slot without inventing the third weight the system does not
 * have. It rides `SectionHeader`'s own `emphasized` instead, which
 * {@link ModelSection} sets. Between the two, BC-31 holds: folding a section
 * loses none of its signal.
 *
 * @param rollup - The section's rolled-up signal.
 */
function SectionRollup({ rollup }: { rollup: NonNullable<SidebarSectionModel['rollup']> }) {
  return (
    <>
      {rollup.workingCount > 0 && (
        <span
          role="img"
          aria-label={`${rollup.workingCount} agents working`}
          className={cn('size-1.5 rounded-full', statusDotClass('working'))}
        />
      )}
      {rollup.unread.tier === 'directed' && <DirectedBadge count={rollup.unread.count} />}
    </>
  );
}

/**
 * One section of a zone — its header when it has one, its rows, its subsections.
 *
 * Collapse is local state seeded from the model, so a reviewer can fold Library
 * open and closed on the page. The model itself never changes: `collapsed` is a
 * preference the model reads, not a decision it makes.
 *
 * @param section - The section to draw.
 * @param state - The snapshot it came from.
 * @param activeKey - The key of the active row, if any.
 * @param showReasons - Whether reason chips are switched on.
 * @param level - Heading level: 3 for a section, 4 for a group sub-header (R2).
 */
function ModelSection({
  section,
  state,
  activeKey,
  showReasons,
  level = 3,
}: {
  section: SidebarSectionModel;
  state: SidebarState;
  activeKey: string | null;
  showReasons: boolean;
  level?: 3 | 4;
}) {
  const [collapsed, setCollapsed] = useState(section.collapsed);
  const listId = `${useId()}-list`;

  return (
    <div data-slot="sidebar-model-section" data-section={section.id} data-reason={section.reason}>
      {section.label !== null ? (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SectionHeader
              label={section.label}
              level={level}
              collapsed={collapsed}
              onToggle={() => setCollapsed((previous) => !previous)}
              controlsId={listId}
              // Folded, and holding unread: the label goes bold. Either tier
              // earns it — `directed` also draws its badge in `trailing`, but
              // `activity` has nowhere else to go (BC-31, §18).
              emphasized={collapsed && (section.rollup?.unread.tier ?? 'none') !== 'none'}
              trailing={
                collapsed && section.rollup ? <SectionRollup rollup={section.rollup} /> : undefined
              }
            />
          </div>
          <ReasonChip reason={section.reason} show={showReasons} className="mr-1 shrink-0" />
        </div>
      ) : (
        // A headerless body — Now's and Today's single section — has no header
        // element at all (R2), so its reason had nowhere to go and was the one
        // kind of node this page did not say "why" about. It gets its own line.
        <div className="flex px-2 pb-0.5">
          <ReasonChip reason={section.reason} show={showReasons} />
        </div>
      )}
      {!collapsed && (
        <SidebarMenu id={listId} className="gap-0">
          {section.rows.map((row) => (
            <ModelRow
              key={row.key}
              row={row}
              state={state}
              activeKey={activeKey}
              showReasons={showReasons}
            />
          ))}
        </SidebarMenu>
      )}
      {!collapsed &&
        section.subsections?.map((subsection) => (
          <div key={subsection.id} className="pl-3">
            <ModelSection
              section={subsection}
              state={state}
              activeKey={activeKey}
              showReasons={showReasons}
              level={4}
            />
          </div>
        ))}
    </div>
  );
}

/**
 * One zone: a landmark heading and the sections under it.
 *
 * The heading is an `<h2>` and never a button — a zone orients, it does not
 * fold (BC-2, design-system §Zones and Sections). The card is one step up the
 * `--sidebar-accent` ramp and carries no border, which is the separation rule
 * this page exists to let somebody check in both themes.
 *
 * @param zone - The zone to draw.
 * @param state - The snapshot it came from.
 * @param activeKey - The key of the active row, if any.
 * @param showReasons - Whether reason chips are switched on.
 * @param fixtureName - The journey this panel is showing, for unique heading ids.
 * @param panelLabelId - Id of the element naming this panel's journey.
 */
function ModelZone({
  zone,
  state,
  activeKey,
  showReasons,
  fixtureName,
  panelLabelId,
}: {
  zone: SidebarZoneModel;
  state: SidebarState;
  activeKey: string | null;
  showReasons: boolean;
  fixtureName: string;
  panelLabelId: string;
}) {
  const headingId = `sidebar-zone-${fixtureName}-${zone.id}`;
  return (
    <section
      data-slot="sidebar-model-zone"
      data-zone={zone.id}
      data-reason={zone.reason}
      // In the app a zone is `aria-labelledby` its own heading and nothing else
      // (R2). Four panels on one page put four "Library" regions in one
      // document, which axe rejects as indistinguishable — correctly, since a
      // screen-reader user would hear the same name four times. The journey's
      // name is prepended so each region is "busy Library", "power Library".
      // The extra id is an artefact of showing four panels at once, not a
      // change to the contract.
      aria-labelledby={`${panelLabelId} ${headingId}`}
      className="bg-sidebar-accent/40 rounded-lg p-1"
    >
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-1">
        <h2 id={headingId} className="text-sidebar-foreground text-xs font-semibold">
          {zone.label}
        </h2>
        <ReasonChip reason={zone.reason} show={showReasons} />
      </div>
      {zone.liveRegionText !== undefined && (
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {zone.liveRegionText}
        </span>
      )}
      {zone.sections.map((section) => (
        <ModelSection
          key={section.id}
          section={section}
          state={state}
          activeKey={activeKey}
          showReasons={showReasons}
        />
      ))}
    </section>
  );
}

/**
 * One journey, as a 272px panel.
 *
 * @param name - The fixture's name.
 * @param state - The snapshot.
 * @param model - What the model made of it.
 * @param showReasons - Whether reason chips are switched on.
 */
function JourneyPanel({
  name,
  state,
  model,
  showReasons,
}: {
  name: string;
  state: SidebarState;
  model: SidebarModel;
  showReasons: boolean;
}) {
  const panelLabelId = `sidebar-model-panel-${name}`;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
        <span id={panelLabelId} className="text-foreground font-medium">
          {name}
        </span>
        <span>
          {model.zones.length} {model.zones.length === 1 ? 'zone' : 'zones'}
        </span>
      </div>
      <nav
        data-slot="sidebar-model-panel"
        data-fixture={name}
        aria-label={`Sidebar (${name})`}
        style={{ width: PANEL_WIDTH }}
        className="bg-sidebar text-sidebar-foreground flex flex-col gap-1.5 rounded-lg p-2"
      >
        {model.zones.map((zone) => (
          <ModelZone
            key={zone.id}
            zone={zone}
            state={state}
            activeKey={anchorKey(state)}
            showReasons={showReasons}
            fixtureName={name}
            panelLabelId={panelLabelId}
          />
        ))}
      </nav>
    </div>
  );
}

/**
 * The four journeys side by side, with every node's reason on show.
 *
 * The four panels are the same four `SidebarState` snapshots the model's table
 * tests run on. Nothing is seeded here, and nothing is tweaked: a state that
 * needs to differ belongs in a fifth fixture, so this page and CI can never
 * drift into showing different things.
 */
export function SidebarModelJourneysShowcase() {
  const [showReasons, setShowReasons] = useState(true);

  return (
    <PlaygroundSection
      title="Sidebar Model Journeys"
      description="buildSidebarModel over all four journey fixtures — first run, quiet morning, busy morning, power user. Each zone, section and row carries the reason the model stamped on it, so 'why is this row here?' is answerable by looking. No server, no clock, no network: the whole panel is one pure function of one snapshot."
    >
      <div className="flex items-center gap-2">
        <Switch id="sidebar-model-reasons" checked={showReasons} onCheckedChange={setShowReasons} />
        <label htmlFor="sidebar-model-reasons" className="text-muted-foreground text-xs">
          Show the reason on every zone, section and row
        </label>
      </div>

      <ShowcaseLabel>Four journeys, one model</ShowcaseLabel>
      {/* The panels are 272px each and there are four of them, so the row
          scrolls sideways inside this box rather than squeezing the panels —
          a squeezed panel would be measuring the wrong width. */}
      <div className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border border-dashed p-4">
        <div className="flex items-start gap-4">
          {SIDEBAR_FIXTURES.map(({ name, state }) => (
            <JourneyPanel
              key={name}
              name={name}
              state={state}
              model={buildSidebarModel(state)}
              showReasons={showReasons}
            />
          ))}
        </div>
      </div>
    </PlaygroundSection>
  );
}

/**
 * The two unread tiers, on the sidebar's own row, in one place.
 *
 * Two tiers and no more (design-decisions §18): something happened here is a
 * **bold label and nothing else**, and something is addressed to you is a
 * numbered amber badge. The tier that draws nothing is the one that keeps
 * getting a dot added back, which is why it is showcased beside the one that
 * does draw something rather than left to a table in a document.
 */
export function SidebarUnreadTiersShowcase() {
  return (
    <PlaygroundSection
      title="Sidebar Unread Tiers"
      description="Two tiers, and no third weight. Activity — something happened here — is a bold label with no badge and no dot. Directed at you — a DM, or an @mention anywhere — is a numbered amber badge. Muting kills both, except that an @mention pierces it."
    >
      <ShowcaseLabel>Activity, directed, read, muted</ShowcaseLabel>
      <div className="border-border/50 bg-muted/30 rounded-lg border border-dashed p-4">
        <nav
          aria-label="Sidebar (unread tiers)"
          style={{ width: PANEL_WIDTH }}
          className="bg-sidebar text-sidebar-foreground rounded-lg p-2"
        >
          <SidebarMenu className="gap-0">
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="releases"
              emphasized
              dataSlot="sidebar-unread-activity"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="design"
              emphasized
              trailing={<DirectedBadge count={2} />}
              dataSlot="sidebar-unread-directed"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="noise"
              dataSlot="sidebar-unread-none"
            />
            <SidebarRow
              glyph={<Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />}
              title="archive"
              muted
              dataSlot="sidebar-unread-muted"
            />
          </SidebarMenu>
        </nav>
      </div>
      <p className="text-muted-foreground text-xs">
        Both themes matter here: switch the theme in the playground footer (
        <Sun className="inline size-3" /> / <Moon className="inline size-3" />) — the tint ramp
        moves away from the panel in the same direction in both, which is why{' '}
        <code className="text-foreground">--muted</code> is banned in this panel.
      </p>
    </PlaygroundSection>
  );
}

/** Every showcase on the Sidebar Model page. */
export function SidebarModelShowcases() {
  return (
    <>
      <SidebarModelJourneysShowcase />
      <SidebarUnreadTiersShowcase />
    </>
  );
}
