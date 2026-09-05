/**
 * One section of one zone — a header and its rows (BC-28 → BC-31).
 *
 * It composes `SectionHeader` and `SidebarModelRow` and decides nothing:
 * membership, order, the rollup arithmetic and whether the section exists at
 * all were all settled in `buildLibrarySections`. What lives here is chrome —
 * the collapse write, the drop zone, the roving tab stop, and the per-section
 * create affordance.
 *
 * @module features/dashboard-sidebar/ui/SidebarSection
 */
import { AnimatePresence } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useRovingFocus, type SidebarDragActivatorProps } from '@/layers/shared/model';
import { SectionHeader, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import type { SidebarSectionModel } from '../model/build-sidebar-model';
import type { SidebarContainer, UngroupedSectionId } from '../model/use-sidebar-dnd';
import { Droppable, Sortable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import { SidebarFoldBody } from './motion/SidebarFoldBody';
import { sectionLayoutKey } from './motion/sidebar-motion';
import { useArrivedRows } from './motion/use-arrived-rows';
import { useSidebarChrome } from './SidebarChrome';
import { dragRefOf, SidebarModelRow } from './SidebarModelRow';
import { useSectionChrome } from './useSectionChrome';

/**
 * The sections whose membership changes without the operator asking for it, and
 * which therefore say so when it does (spec D5, "Arrive, settle, no pulse").
 *
 * Heads up and Today, and deliberately nothing else. A Library section only ever
 * changes because somebody dragged, renamed or created something — the act is
 * its own explanation, and a row announcing an arrival the operator just caused
 * is the decoration this rule exists to keep out.
 */
const ANNOUNCES_ARRIVALS: ReadonlySet<string> = new Set(['now', 'today']);

/**
 * The ungrouped section a section id names, or `undefined` for one that is not
 * an ungrouped section at all.
 *
 * Three ids and no fallback. Pins is its own container, a hand-made section is
 * its own, and Heads up / Today / Getting started are computed — none of them is
 * "ungrouped", so none of them may borrow Agents' name for a drag announcement
 * that would then say "Over Agents." about a row that is nowhere near it.
 *
 * @param id - The section's id.
 */
function ungroupedSectionId(id: SidebarSectionModel['id']): UngroupedSectionId | undefined {
  return id === 'channels' || id === 'dms' || id === 'agents' ? id : undefined;
}

/**
 * The drag container a section's rows belong to.
 *
 * Pins is its own container; Channels, Direct messages and Agents are all
 * "ungrouped" — landing in any of them takes a row out of its section — and a
 * hand-made section is its own. Heads up, Today and Getting started are
 * `computed`, which the drop reducer rejects with a sentence rather than in
 * silence (R3).
 *
 * @param id - The section's id.
 */
export function sectionContainer(id: SidebarSectionModel['id']): SidebarContainer {
  if (id === 'pins') return { kind: 'pinned' };
  if (id.startsWith('group:')) return { kind: 'group', groupId: id.slice('group:'.length) };
  if (id === 'now' || id === 'today' || id === 'getting-started') {
    return { kind: 'computed', zone: id };
  }
  const section = ungroupedSectionId(id);
  // Reached only after pins, hand-made sections and the computed zones have
  // been answered above, so the fallback is unreachable in practice — spelled
  // out rather than defaulted so a new Library section shows up as a wrong
  // announcement here instead of silently becoming Agents everywhere.
  return { kind: 'ungrouped', section: section ?? 'agents' };
}

/** The row-key prefix a section's rows drag under. */
function containerPrefix(id: SidebarSectionModel['id']): string {
  if (id === 'pins') return 'pinned';
  if (id.startsWith('group:')) return id.slice('group:'.length);
  return 'ungrouped';
}

/** Props for {@link SidebarSection}. */
export interface SidebarSectionProps {
  /** The section the model emitted. */
  section: SidebarSectionModel;
  /** Fold or unfold every Library section at once — Alt/Option-click (BC-30). */
  onToggleAll: () => void;
}

/**
 * A section's header and its rows.
 *
 * **The whole header row is the toggle** and every destination is a leaf row,
 * so select-versus-expand is never ambiguous (BC-29). A collapsed section keeps
 * its rollup in the header's trailing slot, so folding never loses signal
 * (BC-31).
 *
 * @param props - The section and the all-sections toggle.
 */
export function SidebarSection({ section, onToggleAll }: SidebarSectionProps) {
  const chrome = useSectionChrome(section);
  const roving = useRovingFocus({
    onCollapse: () => section.collapsible && !section.collapsed && chrome.toggleCollapsed(),
    onExpand: () => section.collapsible && section.collapsed && chrome.toggleCollapsed(),
  });
  const bodyId = `sidebar-section-${section.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const prefix = containerPrefix(section.id);
  const sectionId = ungroupedSectionId(section.id);
  const groupId = section.id.startsWith('group:') ? section.id.slice('group:'.length) : null;

  // What this section's rows measure their FLIP against, and what "a row I have
  // not seen before" is asked of. One string, so both answers come from the same
  // walk and cannot disagree about what order the section is in — including
  // while Today's hold has frozen it, since the held rows ARE `section.rows` by
  // the time they reach here.
  const layoutKey = sectionLayoutKey(section.rows);
  const announcesArrivals = ANNOUNCES_ARRIVALS.has(section.id);
  // The boot gate, not this component's mount: rows turning up while the panel
  // is still loading are the panel loading, not arrivals (spec D6). Read off the
  // panel's ONE subscription rather than calling `useBootState` here — see
  // `SidebarChromeValue.bootSettled` for what a per-section call cost.
  const { bootSettled } = useSidebarChrome();
  const arrived = useArrivedRows(layoutKey, announcesArrivals && bootSettled);

  const list = section.rows.map((row) => (
    <SidebarModelRow
      key={`${prefix}-${row.key}`}
      row={row}
      keyPrefix={prefix}
      layoutKey={layoutKey}
      {...(announcesArrivals ? { arrives: true } : {})}
      {...(arrived.has(row.key) ? { arrived: true } : {})}
      {...(sectionId === undefined ? {} : { sectionId })}
    />
  ));

  const rows = (
    <SidebarMenu id={bodyId}>
      {/* **`initial={false}`, so boot never animates** (D5). Only the two
          sections that announce arrivals are wrapped: everywhere else a row has
          no `exit`, and an `AnimatePresence` around it would be a presence
          wrapper per row bought for nothing. */}
      {announcesArrivals ? <AnimatePresence initial={false}>{list}</AnimatePresence> : list}
    </SidebarMenu>
  );

  // Only the rows the model made drag sources register with dnd-kit, so it
  // never measures a node that has no `Sortable` around it.
  const draggableIds = section.rows.flatMap((row) => {
    if (!row.draggable) return [];
    const ref = dragRefOf(row.target);
    return ref === null ? [] : [sidebarRowDndId(prefix, ref)];
  });

  /**
   * The header, drawn with or without the drag layer's activators.
   *
   * A function rather than one element because only a user-made section is a
   * drag source, and the activators are the drag layer's to hand out — they
   * arrive inside `Sortable`'s render callback below, after this point.
   *
   * @param dragActivator - What the toggle takes so a keyboard can lift the
   *   section (DOR-1746). Omitted for a section that cannot be reordered.
   */
  const renderHeader = (dragActivator?: SidebarDragActivatorProps) => (
    <SectionHeader
      {...(dragActivator === undefined ? {} : { dragActivator })}
      label={section.label ?? ''}
      collapsed={section.collapsed}
      {...(section.collapsible ? { onToggle: chrome.toggleCollapsed, onToggleAll } : {})}
      controlsId={bodyId}
      level={3}
      nodes={chrome.menuNodes}
      actionsLabel={`${section.label ?? 'Section'} section actions`}
      {...(chrome.hasSectionAction ? { hasSectionAction: true } : {})}
      {...(chrome.adornment === undefined ? {} : { adornment: chrome.adornment })}
      {...(chrome.editor === undefined ? {} : { editor: chrome.editor })}
      // Folded and holding unread: the label goes bold, whichever tier it is.
      // `directed` also spells its count out in the roll-up; `activity` is a
      // bold label and nothing else (design-decisions §18), so the weight is
      // where it lives.
      emphasized={section.collapsed && (section.rollup?.unread.tier ?? 'none') !== 'none'}
      {...(section.collapsed && section.rollup !== undefined
        ? { trailing: <SectionRollup section={section} /> }
        : {})}
    />
  );

  return (
    <SidebarGroup
      // `group/section` is what the header's `+` hangs its hover reveal on: the
      // `+` is positioned against this box rather than inside the header's own
      // menu surface, so it needs a named CSS group of its own to watch (R2's
      // "nothing renders at rest", with `focus-visible` and touch as the two
      // other paths).
      //
      // **No indent, because there is no nesting left to show.** A hand-made
      // section used to render inside Agents and wore `--sidebar-nested-x` to
      // say so; sections are peers now (D3), so every header in the panel sits
      // on one x and every row on another — the two levels D1 asked for.
      className="group/section px-0"
      // A stable handle for the page objects — `[data-slot="sidebar-group"]`
      // alone names every section in the panel.
      data-sidebar-section={section.id}
      {...roving}
    >
      {/* A headerless body — Heads up, Today, Getting started — is a zone's single
          section and carries no label of its own; the zone's <h2> names it. */}
      {section.label === null ? null : groupId !== null ? (
        <Sortable id={`group-header::${groupId}`} data={{ type: 'group', groupId }}>
          {(b) => (
            <div
              ref={b.setNodeRef}
              style={b.style}
              {...b.rootProps}
              className={cn(
                // The corner only: the toggle inside rings itself, and this box
                // is not focusable (DOR-1746 — see `SidebarRow`'s drag root).
                'rounded-md',
                b.isDragging && 'opacity-40',
                b.isOver && 'sidebar-drop-ring'
              )}
            >
              {renderHeader(b.activatorProps)}
            </div>
          )}
        </Sortable>
      ) : (
        renderHeader()
      )}
      {chrome.action}
      {chrome.dialogs}
      {/* **The fold, as a height spring** (spec D5) — `SidebarFoldBody` owns the
          numbers and the unmount, and the Dev Playground draws the same
          component rather than a copy of it. */}
      <SidebarFoldBody open={!section.collapsed}>
        <Droppable
          id={`container::${bodyId}`}
          data={{ type: 'container', container: sectionContainer(section.id) }}
        >
          {draggableIds.length > 0 ? (
            <SortableList items={draggableIds}>{rows}</SortableList>
          ) : (
            rows
          )}
          {chrome.footer}
        </Droppable>
      </SidebarFoldBody>
    </SidebarGroup>
  );
}

/**
 * What a folded section says about what it is hiding, as one line of text
 * (BC-31, D1).
 *
 * **Words, not marks.** It used to be a dot and a pill — two shapes borrowed
 * from the row vocabulary, sitting on a header where no row was. Now that every
 * header in the panel folds, folding is an ordinary act and its receipt is an
 * ordinary sentence: "12 · 3 unread". A screen reader gets the same string.
 *
 * Heads up says "2 need you" instead of a row count, because its rows include
 * the "N working" report — which needs nobody — and folding it must never be a
 * quiet way to hide a permission prompt.
 *
 * Renders nothing while the section is open: the rows say it better.
 *
 * @param props - The section.
 */
function SectionRollup({ section }: { section: SidebarSectionModel }) {
  const rollup = section.rollup;
  if (!section.collapsed || rollup === undefined) return null;
  const parts: string[] = [];
  const working = rollup.workingCount > 0 ? `${rollup.workingCount} working` : null;
  if (rollup.needsYouCount !== undefined) {
    // **Heads up counts what needs answering, and never a bare item count.**
    // Its rows include the "N working" report, which needs nobody — so a Heads
    // up holding only that report folded to "1", which reads as one thing
    // waiting on you when nothing is. With nothing to answer, the fold says
    // what is actually in there: the work.
    if (rollup.needsYouCount > 0) parts.push(`${rollup.needsYouCount} need you`);
    else if (working !== null) parts.push(working);
  } else {
    parts.push(`${rollup.count}`);
  }
  if (rollup.unread.tier === 'directed' && (rollup.unread.count ?? 0) > 0) {
    parts.push(`${rollup.unread.count} unread`);
  } else if (rollup.unread.tier === 'activity') {
    // Tier one is a bold label and nothing else (design-decisions §18) — which
    // the header wears through `emphasized`. "new" is here so a reader who
    // cannot see the weight is told the same thing, and it is deliberately not
    // the word "unread": beside "3 unread" on the same line, a bare "unread"
    // read as a truncated count rather than as a different tier.
    parts.push('new');
  }
  // Already spent above when Heads up had nothing to answer.
  if (working !== null && !parts.includes(working)) parts.push(working);
  return <>{parts.join(' · ')}</>;
}
