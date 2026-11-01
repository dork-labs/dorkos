/**
 * One section — a header and its rows (BC-28 → BC-31).
 *
 * It composes `SectionHeader` and `SidebarModelRow` and decides nothing:
 * membership, order, the rollup arithmetic and whether the section exists at
 * all were all settled in `buildSections`. What lives here is chrome —
 * the collapse write, the drop zone, the roving tab stop, and the per-section
 * create affordance.
 *
 * @module features/dashboard-sidebar/ui/SidebarSection
 */
import { memo, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useRovingFocus, type SidebarDragActivatorProps } from '@/layers/shared/model';
import { SectionHeader, SidebarGroup, SidebarMenu, statusDotClass } from '@/layers/shared/ui';
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
 * Direct messages, and deliberately nothing else: an agent or a person can
 * start a conversation with you, and its row arriving is news. Every other
 * section only changes because somebody dragged, renamed or created something —
 * the act is its own explanation, and a row announcing an arrival the operator
 * just caused is the decoration this rule exists to keep out.
 */
const ANNOUNCES_ARRIVALS: ReadonlySet<string> = new Set(['dms']);

/**
 * The section header, memoized — because a draggable one is rebuilt on every
 * tick of a drag.
 *
 * A user-made section's header is rendered inside `Sortable`'s render callback,
 * and `useSortable` re-renders every sortable in its context on every transform
 * frame — so a header that was a plain element re-rendered its label, its
 * roll-up, its chevron and its whole menu surface once per pointer-move, for
 * every section on screen, for the length of a drag. It is the same reason
 * `RoomRow` is memoized (`specs/sidebar-simplification` D8), one level up.
 *
 * The memo only pays if the props hold still, which is why `trailing` is
 * memoized where it is built and `dragActivator` is memoized in
 * `SidebarDndPrimitives`: both are the kind of prop — a fresh element, a fresh
 * object — that quietly defeats a `memo` from the outside.
 */
const MemoSectionHeader = memo(SectionHeader);

/**
 * The ungrouped section a section id names, or `undefined` for one that is not
 * an ungrouped section at all.
 *
 * Two ids and no fallback. A hand-made section is its own container, and the
 * top items and Add-ons fill themselves — none of them is "ungrouped", so none
 * of them may borrow another section's name for a drag announcement.
 *
 * @param id - The section's id.
 */
function ungroupedSectionId(id: SidebarSectionModel['id']): UngroupedSectionId | undefined {
  return id === 'channels' || id === 'dms' ? id : undefined;
}

/**
 * The drag container a section's rows belong to.
 *
 * Channels and Direct messages are both "ungrouped" — landing in either takes
 * a row out of its section — and a hand-made section is its own. The top items
 * and Add-ons fill themselves, so they are `computed`, which the drop reducer
 * rejects with a sentence rather than in silence (R3).
 *
 * @param id - The section's id.
 */
export function sectionContainer(id: SidebarSectionModel['id']): SidebarContainer {
  if (id.startsWith('group:')) return { kind: 'group', groupId: id.slice('group:'.length) };
  if (id === 'top' || id === 'addons') return { kind: 'computed', section: id };
  // Reached only after hand-made sections and the computed ones have been
  // answered above, so the fallback is unreachable in practice — spelled out
  // rather than defaulted so a new section shows up as a wrong announcement
  // here instead of silently becoming Direct messages everywhere.
  return { kind: 'ungrouped', section: ungroupedSectionId(id) ?? 'dms' };
}

/** The row-key prefix a section's rows drag under. */
function containerPrefix(id: SidebarSectionModel['id']): string {
  if (id.startsWith('group:')) return id.slice('group:'.length);
  return 'ungrouped';
}

/** Props for {@link SidebarSection}. */
export interface SidebarSectionProps {
  /** The section the model emitted. */
  section: SidebarSectionModel;
  /** Fold or unfold every section at once — Alt/Option-click (BC-30). */
  onToggleAll: () => void;
}

/**
 * A section's header and its rows.
 *
 * **The whole header row is the toggle** and every destination is a leaf row,
 * so select-versus-expand is never ambiguous (BC-29). A collapsed section keeps
 * its unread rows on screen under the header, so folding never loses signal
 * (BC-31). The header carries no unread count — only "· N more", the rows the
 * fold hides (DOR-3200).
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
  // walk and cannot disagree about what order the section is in.
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
      {/* **`initial={false}`, so boot never animates** (D5). Only the section
          that announces arrivals is wrapped: everywhere else a row has no
          `exit`, and an `AnimatePresence` around it would be a presence wrapper
          per row bought for nothing. */}
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

  // Built here rather than in the header below, because the header below is
  // rebuilt on every frame of a drag and a fresh element per frame is exactly
  // what stops {@link MemoSectionHeader} from bailing out.
  const trailing = useMemo(
    () =>
      section.collapsed && (section.rollup?.workingCount ?? 0) > 0 ? (
        <FoldedWorkingDot count={section.rollup?.workingCount ?? 0} />
      ) : undefined,
    [section]
  );
  const keptRows = section.collapsed ? (section.rollup?.keptRows ?? []) : [];
  const keptLayoutKey = sectionLayoutKey(keptRows);

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
    <MemoSectionHeader
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
      {...(trailing === undefined ? {} : { trailing })}
      {...(section.collapsed && section.rollup ? { hiddenCount: section.rollup.hiddenCount } : {})}
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
      //
      // `max-md:py-3`: 24px between sections on a phone rather than 20, the
      // 11.4 step for a 44px list (Phase 4 P2).
      className="group/section px-0 max-md:py-3"
      // A stable handle for the page objects — `[data-slot="sidebar-group"]`
      // alone names every section in the panel.
      data-sidebar-section={section.id}
      {...roving}
    >
      {/* A headerless body — the top items — carries no label of its own. */}
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
          component rather than a copy of it. What folding leaves on screen
          (BC-31) is the rows still asking for something, drawn exactly as they
          are when the section is open, and only once the body has finished
          leaving so no row is ever drawn twice. They are not drag sources —
          the model says so — because a folded section has nowhere to drop. */}
      <SidebarFoldBody
        open={!section.collapsed}
        whenFolded={
          keptRows.length > 0 ? (
            <SidebarMenu data-slot="sidebar-section-kept">
              {keptRows.map((row) => (
                <SidebarModelRow
                  key={`${prefix}-${row.key}`}
                  row={row}
                  keyPrefix={prefix}
                  layoutKey={keptLayoutKey}
                  {...(sectionId === undefined ? {} : { sectionId })}
                />
              ))}
            </SidebarMenu>
          ) : undefined
        }
      >
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
 * The one mark a folded header carries: a dot while any of its members are
 * working (BC-31).
 *
 * **Never a number.** Unread needs no mark here at all — the rows asking for
 * something stay on screen under the folded header — but work in flight has
 * no row of its own to stay behind, so the header says it, once, without
 * counting it — "Agent working" or "Agents working", never a number.
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
