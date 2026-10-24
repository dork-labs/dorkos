/**
 * The whole sidebar, as `buildSidebarModel` decides it, across all four journeys.
 *
 * This page is the model's window. `buildSidebarModel` is pure and takes one
 * snapshot, so the entire panel can be looked at — every section, every row,
 * every rollup, in both themes — with no server, no agents on disk and no
 * clock. The four journey fixtures that drive the model's table tests drive
 * these showcases and `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`
 * as well, so what a reviewer looks at and what CI asserts are the same states.
 *
 * **Every node says why it is there.** Each section and row renders its
 * `reason` beside it — the headerless top items included, which have no header
 * element to hang a chip off and so get their own line. So "why is this row
 * here?" is answered by looking rather than by reading `rules/`. The chips can
 * be turned off to see the panel as an operator would.
 *
 * Rows are the real `SidebarRow` and headers the real `SectionHeader` — nothing
 * about a row's chrome is re-drawn here. What this file holds is the walk from
 * `SidebarModel` to those primitives without the providers the real panel
 * needs (a roster, a router, a transport).
 *
 * **Deep imports on purpose.** `buildSidebarModel` and the fixtures are not on
 * the `features/dashboard-sidebar` barrel, and should not be: they are consumed
 * by the model's own tests and by this page, not by the app. The Dev Playground
 * has always reached past feature barrels for exactly this reason, which keeps
 * a playground-only symbol out of a public surface.
 *
 * @module dev/showcases/SidebarModelShowcases
 */
import { useId, useState } from 'react';
import { cn } from '@/layers/shared/lib';
import { SectionHeader, SidebarMenu, SidebarRow, Switch, statusDotClass } from '@/layers/shared/ui';
import type {
  SidebarModel,
  SidebarRowModel,
  SidebarSectionModel,
} from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import { SIDEBAR_FIXTURES } from '@/layers/features/dashboard-sidebar/model/fixtures';
import { RowGlyph } from './sidebar-model-row-glyph';
import { rollUpCollapsedSection } from '@/layers/features/dashboard-sidebar/model/rules/roll-up-collapsed-section';
import { rowKey } from '@/layers/features/dashboard-sidebar/model/rules/targets';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import {
  DirectedBadge,
  PANEL_WIDTH,
  SidebarUnreadTiersShowcase,
} from './SidebarUnreadTiersShowcase';

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
        'text-sidebar-foreground/70 bg-sidebar/80 text-3xs rounded px-1 font-mono leading-4',
        show ? 'inline-block' : 'sr-only',
        className
      )}
    >
      {reason}
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
          measured 4.21 on the active row's tint, which
          the axe gate in `sidebar-model-showcase.spec.ts` failed on. The icons
          below stay at `/60` — they are graphics, not text, and owe 3:1. */}
      {row.liveCount !== undefined && (
        <span className="text-sidebar-foreground/70 text-3xs tabular-nums">
          {row.liveCount} live
        </span>
      )}
      {row.unread.tier === 'directed' && row.unread.count !== undefined && (
        <DirectedBadge count={row.unread.count} />
      )}
    </>
  );
}

/**
 * One row of the model, drawn by the sidebar's own row primitive.
 *
 * The mapping is the whole component: a row with a `secondary` is a page that
 * shares its title with another, so its `who` names the extension and the `›`
 * appears; a row without one takes the title slot directly.
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
      isActive={row.key === activeKey}
      emphasized={row.unread.tier !== 'none' && !row.muted}
      muted={row.muted}
      dataSlot="sidebar-model-row"
      expansion={
        <ReasonChip reason={row.reason} show={showReasons} className="mb-0.5 ml-9 max-w-full" />
      }
    />
  );
}

/**
 * The one mark a folded header carries: a dot while something inside is
 * working, never a number (BC-31).
 *
 * Kept in step with `features/dashboard-sidebar/ui/SidebarSection.tsx`, which is
 * what the cockpit really draws.
 *
 * @param props.count - How many members are working; only one-or-more matters.
 */
function FoldedWorkingDot({ count }: { count: number }) {
  return (
    <span
      role="img"
      aria-label={count === 1 ? 'Agent working' : 'Agents working'}
      className={cn('inline-block size-1.5 rounded-full', statusDotClass('working'))}
    />
  );
}

/**
 * One section — its header when it has one, and its rows. Hand-made sections are
 * peers of Channels and Direct messages, so there is no nesting to draw (D3).
 *
 * Collapse is local state seeded from the model, so a reviewer can fold a
 * section open and closed on the page. The model itself never changes: `collapsed` is a
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
  // The model rolls up only what it was told is folded; a section folded here,
  // on the page, is rolled up the same way so it keeps the same rows.
  const rollup =
    section.rollup ??
    rollUpCollapsedSection(
      section.rows,
      () => false,
      () => false
    );
  const shownRows = collapsed ? rollup.keptRows : section.rows;

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
              // Never an unread count, and never bold: the rows still asking
              // for something stay on screen below a folded header (BC-31).
              // Only "· N more", the rows the fold hides (DOR-3200).
              {...(collapsed ? { hiddenCount: rollup.hiddenCount } : {})}
              {...(collapsed && rollup.workingCount > 0
                ? { trailing: <FoldedWorkingDot count={rollup.workingCount} /> }
                : {})}
            />
          </div>
          <ReasonChip reason={section.reason} show={showReasons} className="mr-1 shrink-0" />
        </div>
      ) : (
        // A headerless body — the top items — has no header element at all
        // (R2), so its reason gets its own line.
        <div className="flex px-2 pb-0.5">
          <ReasonChip reason={section.reason} show={showReasons} />
        </div>
      )}
      {shownRows.length > 0 && (
        <SidebarMenu
          id={collapsed ? undefined : listId}
          data-slot={collapsed ? 'sidebar-model-kept-rows' : undefined}
          className="gap-0"
        >
          {shownRows.map((row) => (
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
    </div>
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
  const activeKey = state.activeTarget === null ? null : rowKey(state.activeTarget);
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
        <span className="text-foreground font-medium">{name}</span>
        <span>
          {model.sections.length} {model.sections.length === 1 ? 'section' : 'sections'}
        </span>
      </div>
      <nav
        data-slot="sidebar-model-panel"
        data-fixture={name}
        aria-label={`Sidebar (${name})`}
        style={{ width: PANEL_WIDTH }}
        className="bg-sidebar text-sidebar-foreground flex flex-col gap-1.5 rounded-lg p-2"
      >
        {model.sections.map((section) => (
          <ModelSection
            key={section.id}
            section={section}
            state={state}
            activeKey={activeKey}
            showReasons={showReasons}
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
      description="buildSidebarModel over all four journey fixtures — first run, quiet morning, busy morning, power user. The list holds places, never sessions or threads: the doors to Threads and the Directory, your own sections, Channels, Direct messages (an agent is its direct message) and Add-ons. Each section and row carries the reason the model stamped on it. No server, no clock, no network: the whole panel is one pure function of one snapshot."
    >
      <div className="flex items-center gap-2">
        <Switch id="sidebar-model-reasons" checked={showReasons} onCheckedChange={setShowReasons} />
        <label htmlFor="sidebar-model-reasons" className="text-muted-foreground text-xs">
          Show the reason on every section and row
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

/** Every showcase on the Sidebar Model page. */
export function SidebarModelShowcases() {
  return (
    <>
      <SidebarModelJourneysShowcase />
      <SidebarUnreadTiersShowcase />
    </>
  );
}
