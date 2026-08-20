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
 * `reason` beside it — **every one of them, including the headerless bodies Heads up
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
  Hash,
  Loader,
  MessageSquarePlus,
  Moon,
  ShieldQuestion,
  Sparkles,
  Sun,
  UserPlus,
} from 'lucide-react';
import { cn, resolveAgentVisual } from '@/layers/shared/lib';
import {
  IdentityAvatar,
  SectionHeader,
  SidebarMenu,
  SidebarRow,
  Switch,
  statusDotClass,
} from '@/layers/shared/ui';
import type {
  SidebarIconId,
  SidebarModel,
  SidebarRowModel,
  SidebarSectionModel,
  SidebarZoneModel,
} from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import {
  buildSidebarModel,
  ZONE_LABEL,
} from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { SIDEBAR_FIXTURES } from '@/layers/features/dashboard-sidebar/model/fixtures';
import { SidebarZone } from '@/layers/features/dashboard-sidebar/ui/SidebarZone';
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
  schedule: CalendarClock,
  overflow: ChevronRight,
  working: Loader,
  automated: CalendarClock,
  digest: Sparkles,
  'add-agent': UserPlus,
  'first-session': MessageSquarePlus,
  team: Hash,
  dorkbot: Bot,
  session: MessageSquarePlus,
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
  const { glyph } = row;

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
        color={visual.color}
        emoji={visual.emoji}
        fallback={(state.displayNames[glyph.agentPath] ?? '?').slice(0, 1).toUpperCase()}
        className="size-[18px] text-[9px]"
      />
    );
  }
  // `hash`, and the union has no fourth member — so this is the branch rather
  // than a default after one, and adding a glyph kind makes the type error here
  // instead of quietly drawing a `#` for it.
  return <Hash aria-hidden className="text-sidebar-foreground/60 size-3.5" />;
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
 * The trailing meta a row carries: its unread mark and its live-session count.
 *
 * **The `activity` tier draws nothing here on purpose.** Bold label only — no
 * badge and no dot (design-decisions §18). The bold is the row's `emphasized`
 * prop; this slot stays empty, and a mark appearing here for an activity-tier
 * row is the regression to look for.
 *
 * @param row - The row whose trailing slot this is.
 */
function RowTrailing({ row }: { row: SidebarRowModel }) {
  return (
    <>
      {/* `/70`, not `/60`. At 10px these are small text and owe 4.5:1; `/60`
          measured 4.21 on the active row's tint and 4.27 on the zone card, which
          the axe gate in `sidebar-model-showcase.spec.ts` failed on. The icons
          below stay at `/60` — they are graphics, not text, and owe 3:1. */}
      {row.liveCount !== undefined && (
        <span className="text-sidebar-foreground/70 text-[10px] tabular-nums">
          {row.liveCount} live
        </span>
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
 * What a folded section says about what it is hiding, as one line of text
 * (BC-31, `specs/sidebar-simplification` D1).
 *
 * **Words, not marks.** It used to be a dot and a numbered pill — two shapes
 * borrowed from the row vocabulary, drawn on a header where no row was, which is
 * a third weight the two-tier system deliberately does not have. Now that every
 * header in the panel folds, folding is an ordinary act and its receipt is an
 * ordinary sentence.
 *
 * Kept in step with `features/dashboard-sidebar/ui/SidebarSection.tsx`, which is
 * what the cockpit really draws.
 *
 * @param rollup - The section's rolled-up signal.
 */
function sectionRollupText(rollup: NonNullable<SidebarSectionModel['rollup']>): string {
  const parts: string[] = [];
  parts.push(
    rollup.needsYouCount !== undefined && rollup.needsYouCount > 0
      ? `${rollup.needsYouCount} need you`
      : `${rollup.count}`
  );
  if (rollup.unread.tier === 'directed' && (rollup.unread.count ?? 0) > 0) {
    parts.push(`${rollup.unread.count} unread`);
  } else if (rollup.unread.tier === 'activity') {
    parts.push('unread');
  }
  if (rollup.workingCount > 0) parts.push(`${rollup.workingCount} working`);
  return parts.join(' · ');
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
              {...(collapsed && section.rollup
                ? { trailing: sectionRollupText(section.rollup) }
                : {})}
            />
          </div>
          <ReasonChip reason={section.reason} show={showReasons} className="mr-1 shrink-0" />
        </div>
      ) : (
        // A headerless body — Heads up's and Today's single section — has no header
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
          // `--sidebar-nested-x`, the same token `SidebarSection` indents a
          // real subsection by (D1). It was a literal `pl-3`, which is 12px by
          // coincidence rather than by derivation — this page's whole job is to
          // show what the cockpit draws, and a copy that happens to agree today
          // is what let a contrast defect hide from its own gate once already.
          <div key={subsection.id} className="pl-[var(--sidebar-nested-x)]">
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
 * One zone: a named landmark and the sections under it.
 *
 * **It draws no heading of its own** (`specs/sidebar-simplification` D1). The
 * panel is two levels now — the section header inside is what a person reads,
 * and the zone's name reaches assistive tech through `aria-label`. The card is
 * one step up the `--sidebar-accent` ramp and carries no border, which is the
 * separation rule this page exists to let somebody check in both themes.
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
  return (
    <section
      data-slot="sidebar-model-zone"
      data-zone={zone.id}
      data-reason={zone.reason}
      // In the app a zone is named by `aria-label` and draws nothing (D1). Four
      // panels on one page put four "Library" regions in one document, which axe
      // rejects as indistinguishable — correctly, since a screen-reader user
      // would hear the same name four times. The journey's name is prepended so
      // each region is "busy Library", "power Library". The prefix is an
      // artefact of showing four panels at once, not a change to the contract.
      aria-label={`${fixtureName} ${zone.label}`}
      className="bg-sidebar-accent/40 rounded-lg p-1"
    >
      <div className="flex px-2">
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

/**
 * The four states Heads up passes through, side by side.
 *
 * Heads up is the zone the whole redesign is for, and three of its four states
 * are hard to catch in the running app on purpose: an empty one is the calm signal,
 * an overflowing one needs seven things to be waiting at once, and the beat
 * lasts two and a half seconds. They are drawn here from spreads over the
 * shipped fixtures — never edits to them — so a reviewer can look at all four
 * at once and in both themes.
 */
/** The zone the beat plays in, exactly as `SidebarZones` synthesizes it. */
const ALL_CLEAR_ZONE: SidebarZoneModel = {
  id: 'now',
  label: ZONE_LABEL.now,
  sections: [],
  reason: 'zone:now',
};

export function SidebarNowStatesShowcase() {
  // Reasons default ON, exactly as the journeys showcase does. Two reasons: the
  // provenance is the point of this page, and the browser suite's axe coverage
  // guard counts the reason chips it managed to evaluate — a panel drawing them
  // invisibly would silently shrink what the contrast gate actually looked at.
  const [showReasons, setShowReasons] = useState(true);

  // Variants, built with a spread. The fixture files are read by several tasks
  // at once, so a tweak to one would become somebody else's failing expectation
  // (`contributing/sidebar-model.md`).
  const quiet = SIDEBAR_FIXTURES.find((f) => f.name === 'quiet')!.state;
  const busy = SIDEBAR_FIXTURES.find((f) => f.name === 'busy')!.state;
  const power = SIDEBAR_FIXTURES.find((f) => f.name === 'power')!.state;

  const empty: SidebarState = { ...quiet, attention: [], workingSessionIds: [] };
  const single: SidebarState = { ...busy, attention: busy.attention.slice(0, 1) };
  // **The one blockage with no face**, and the only way its glyph reaches the
  // both-themes and axe gates. Every other signal in the fixtures carries an
  // `agentPath`, so the row draws an avatar and the semantic icon behind it is
  // never rendered — a schedule belongs to a timer rather than to an agent, so
  // this is the state where `CalendarClock` is actually on screen (DOR-1391).
  const schedule: SidebarState = {
    ...busy,
    workingSessionIds: [],
    attention: [
      {
        id: 'schedule:tsk-nightly',
        kind: 'schedule-approval',
        primary: 'Nightly audit',
        secondary: 'Wants to run on a timer',
        since: new Date(busy.now - 24 * 60_000).toISOString(),
        deepLink: '/tasks',
      },
    ],
  };

  // **One line each, and that is a constraint rather than a style.** The panel
  // label is the only text on this page axe cannot judge when it wraps: a
  // wrapped caption's rects straddle the scroll container's clip and come back
  // `incomplete`, which the browser suite treats as a hole in the contrast gate.
  // The sentences live in the section's own description instead.
  const states: { name: string; caption: string; state: SidebarState }[] = [
    { name: 'now-empty', caption: 'Nothing waiting', state: empty },
    { name: 'now-one', caption: 'One thing needs you', state: single },
    { name: 'now-schedule', caption: 'A schedule parked', state: schedule },
    { name: 'now-capped', caption: 'Seven waiting, capped', state: power },
    {
      name: 'getting-started',
      caption: 'Day one',
      state: SIDEBAR_FIXTURES.find((f) => f.name === 'first-run')!.state,
    },
  ];

  return (
    <PlaygroundSection
      title="Sidebar Heads Up States"
      description="Heads up is the first thing on screen and the only zone allowed to interrupt. Five states: nothing waiting (the zone disappears entirely — absence is the calm signal), one thing waiting, a schedule an agent parked for approval (the one blockage drawn with a glyph rather than a face, because it belongs to a timer), seven things waiting (capped at three with an overflow that leads to the home surface), and the day-one Getting started zone that shares the same slot."
    >
      <div className="flex items-center gap-2">
        <Switch
          id="sidebar-heads-up-states-reasons"
          checked={showReasons}
          onCheckedChange={setShowReasons}
        />
        <label htmlFor="sidebar-heads-up-states-reasons" className="text-muted-foreground text-xs">
          Show the reason on every zone, section and row
        </label>
      </div>

      <ShowcaseLabel>
        Empty, one signal, a parked schedule, capped with overflow, day one
      </ShowcaseLabel>
      <div className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border border-dashed p-4">
        {/* Wraps rather than scrolls, and since DOR-1391's fifth state it does:
            five 272px panels are wider than the content column at the width the
            browser suite runs at, so the last one drops to a second line. That
            is the intended failure mode — a panel clipped by a horizontal
            scroller is one axe declines to measure, while a wrapped one is
            fully in the grid. The spec's viewport carries the extra height. */}
        <div className="flex flex-wrap items-start gap-4">
          {states.map(({ name, caption, state }) => (
            <div key={name} className="flex shrink-0 flex-col gap-2" style={{ width: PANEL_WIDTH }}>
              {/* The short name carries the id the zone's landmark is labelled
                  BY — a dangling `aria-labelledby` leaves every panel's region
                  nameless, which axe reds as `landmark-unique`. The sentence
                  sits beside it rather than inside it, matching the journey
                  panels above, so the accessible name stays two words. */}
              <div className="flex flex-col gap-0.5">
                <span
                  id={`sidebar-now-state-${name}`}
                  className="text-foreground text-xs font-medium"
                >
                  {name}
                </span>
                <span className="text-muted-foreground text-xs">{caption}</span>
              </div>
              <nav
                data-slot="sidebar-now-state"
                data-state-name={name}
                aria-label={`${ZONE_LABEL.now} (${name})`}
                className="bg-sidebar text-sidebar-foreground flex flex-col gap-1.5 rounded-lg p-2"
              >
                {buildSidebarModel(state)
                  .zones.filter((zone) => zone.id === 'now' || zone.id === 'getting-started')
                  .map((zone) => (
                    <ModelZone
                      key={zone.id}
                      zone={zone}
                      state={state}
                      activeKey={anchorKey(state)}
                      showReasons={showReasons}
                      fixtureName={name}
                      panelLabelId={`sidebar-now-state-${name}`}
                    />
                  ))}
              </nav>
            </div>
          ))}
        </div>
      </div>

      <ShowcaseLabel>The all-clear beat</ShowcaseLabel>
      {/* The REAL `SidebarZone`, not a drawing of one. It needs no providers
          with an empty section list, and rendering it here is what puts the
          shipped zone heading in front of the axe gate below — a hand-rolled
          copy measured a copy, and the copy is what drifted. */}
      <div className="border-border/50 bg-muted/30 rounded-lg border border-dashed p-4">
        <nav
          aria-label={`${ZONE_LABEL.now} (all clear)`}
          style={{ width: PANEL_WIDTH }}
          className="bg-sidebar text-sidebar-foreground rounded-lg p-2"
        >
          <SidebarZone zone={ALL_CLEAR_ZONE} onToggleAll={() => {}} allClear />
        </nav>
      </div>
      <p className="text-muted-foreground text-xs">
        When the last thing needing you resolves, Heads up settles on this for 2.5 seconds and then
        folds away — finishing a queue should feel like finishing. Under a reduced-motion preference
        it never renders at all and the zone simply disappears.
      </p>
    </PlaygroundSection>
  );
}

/**
 * The four states Today passes through, side by side.
 *
 * Today is the zone the 40-rows-down problem disappears into, and its states
 * are hard to catch in the running app for the ordinary reason: they depend on
 * a clock, on an absence, and on where the operator has been. They are drawn
 * here from spreads over the shipped fixtures — never edits to them — so a
 * reviewer can compare all four against the mockups in both themes.
 *
 * The two behaviours that are NOT here are the two that need hands: the order
 * holding still under a pointer (BC-17) and the anchor scrolling into view on a
 * conversation switch (BC-36). Both are asserted against the real
 * `DashboardSidebar` in `DashboardSidebar.test.tsx`, because a static page
 * cannot show a row refusing to move.
 */
export function SidebarTodayStatesShowcase() {
  const [showReasons, setShowReasons] = useState(true);

  const busy = SIDEBAR_FIXTURES.find((f) => f.name === 'busy')!.state;

  // Anchored: exactly the shipped `busy` journey, which already has a session
  // open — this is what an operator sees while working with one agent.
  const anchored = busy;
  // With the digest. TWO things stand between `busy` and a morning after an
  // absence, and the screenshot pass is what found the second: the fixture's
  // own `lastShownDate` is already today, so content alone draws nothing
  // (BC-22's second condition). Both are moved, or the panel is a copy of the
  // one beside it.
  const withDigest: SidebarState = {
    ...busy,
    digest: { finishedWhileAwayCount: 4, idleWhileAwayCount: 2 },
    prefs: { ...busy.prefs, digest: { lastShownDate: '2026-08-08' } },
  };
  // The reveal, open. The runs hang off the bottom of the finished list,
  // origin-marked, spending none of the soft cap.
  const revealed: SidebarState = { ...busy, todayAutomatedExpanded: true };
  // The morning after. `now` moved past 04:00 with nothing touched since, so
  // everything but the anchor and the directed unread has left the zone.
  const archived: SidebarState = { ...busy, now: busy.now + 24 * 60 * 60 * 1000 };

  const states: { name: string; caption: string; state: SidebarState }[] = [
    { name: 'anchored', caption: 'The conversation you have open', state: anchored },
    { name: 'digest', caption: 'A morning after an absence', state: withDigest },
    { name: 'automated', caption: 'The reveal, opened', state: revealed },
    { name: 'archived', caption: 'A day later, untouched', state: archived },
  ];

  return (
    <PlaygroundSection
      title="Sidebar Today States"
      description="Today is what you were doing, in the order YOU last touched it — never the order your agents last did something. Four states: the conversation you have open pinned to the top with live status, the once-a-day welcome-back row below it, the automated runs unfolded behind their reveal, and the morning after, when everything untouched since 4am has quietly left."
    >
      <div className="flex items-center gap-2">
        <Switch
          id="sidebar-today-states-reasons"
          checked={showReasons}
          onCheckedChange={setShowReasons}
        />
        <label htmlFor="sidebar-today-states-reasons" className="text-muted-foreground text-xs">
          Show the reason on every zone, section and row
        </label>
      </div>

      <ShowcaseLabel>Anchored, with the digest, runs revealed, the morning after</ShowcaseLabel>
      <div className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border border-dashed p-4">
        {/* Wraps rather than scrolls, for the same reason the Heads up states do: a
            panel clipped by a horizontal scroller is one axe declines to
            measure. */}
        <div className="flex flex-wrap items-start gap-4">
          {states.map(({ name, caption, state }) => (
            <div key={name} className="flex shrink-0 flex-col gap-2" style={{ width: PANEL_WIDTH }}>
              <div className="flex flex-col gap-0.5">
                <span
                  id={`sidebar-today-state-${name}`}
                  className="text-foreground text-xs font-medium"
                >
                  {name}
                </span>
                <span className="text-muted-foreground text-xs">{caption}</span>
              </div>
              <nav
                data-slot="sidebar-today-state"
                data-state-name={name}
                aria-label={`Today (${name})`}
                className="bg-sidebar text-sidebar-foreground flex flex-col gap-1.5 rounded-lg p-2"
              >
                {buildSidebarModel(state)
                  .zones.filter((zone) => zone.id === 'today')
                  .map((zone) => (
                    <ModelZone
                      key={zone.id}
                      zone={zone}
                      state={state}
                      activeKey={anchorKey(state)}
                      showReasons={showReasons}
                      fixtureName={`today-${name}`}
                      panelLabelId={`sidebar-today-state-${name}`}
                    />
                  ))}
              </nav>
            </div>
          ))}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        The first row of every panel is the anchor — the conversation the operator has open. It is
        pinned there while it is open, carries the live status, and is exempt from the soft cap and
        from the overnight boundary, which is why it is still the first row in the fourth panel a
        day later.
      </p>
    </PlaygroundSection>
  );
}

/** Every showcase on the Sidebar Model page. */
export function SidebarModelShowcases() {
  return (
    <>
      <SidebarModelJourneysShowcase />
      <SidebarNowStatesShowcase />
      <SidebarTodayStatesShowcase />
      <SidebarUnreadTiersShowcase />
    </>
  );
}
