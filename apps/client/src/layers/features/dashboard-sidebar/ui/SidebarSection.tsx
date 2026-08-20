/**
 * One section of one zone — a header, its rows, and at most one level of
 * sub-headers (BC-28 → BC-31).
 *
 * It composes `SectionHeader` and `SidebarModelRow` and decides nothing:
 * membership, order, the rollup arithmetic and whether the section exists at
 * all were all settled in `buildLibrarySections`. What lives here is chrome —
 * the collapse write, the drop zone, the roving tab stop, and the per-section
 * create affordance.
 *
 * @module features/dashboard-sidebar/ui/SidebarSection
 */
import { cn } from '@/layers/shared/lib';
import { useRovingFocus } from '@/layers/shared/model';
import { SectionHeader, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import type { SidebarSectionModel } from '../model/build-sidebar-model';
import type { SidebarContainer, UngroupedSectionId } from '../model/use-sidebar-dnd';
import { Droppable, Sortable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import { dragRefOf, SidebarModelRow } from './SidebarModelRow';
import { useSectionChrome } from './useSectionChrome';

/**
 * The ungrouped section a section id names, or `undefined` for one that is not
 * an ungrouped section at all.
 *
 * Three ids and no fallback. Pins is its own container, a group is its own, and
 * Heads up / Today / Getting started are computed — none of them is "ungrouped",
 * so none of them may borrow Agents' name for a drag announcement that would
 * then say "Over Agents." about a row that is nowhere near it.
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
 * "ungrouped" — landing in any of them takes a row out of its group — and a
 * group is its own. Heads up, Today and Getting started are `computed`, which the
 * drop reducer rejects with a sentence rather than in silence (R3).
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
  // Reached only after pins, groups and the computed zones have been answered
  // above, so the fallback is unreachable in practice — spelled out rather than
  // defaulted so a new Library section shows up as a wrong announcement here
  // instead of silently becoming Agents everywhere.
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
  /** A group sub-header sits one level in: an `<h4>`, indented by 14px. */
  isSubsection?: boolean;
}

/**
 * A section's header, its rows, and its groups.
 *
 * **The whole header row is the toggle** and every destination is a leaf row,
 * so select-versus-expand is never ambiguous (BC-29). A collapsed section keeps
 * its rollup in the header's trailing slot, so folding never loses signal
 * (BC-31).
 *
 * @param props - The section and the all-sections toggle.
 */
export function SidebarSection({
  section,
  onToggleAll,
  isSubsection = false,
}: SidebarSectionProps) {
  const chrome = useSectionChrome(section);
  const roving = useRovingFocus({
    onCollapse: () => section.collapsible && !section.collapsed && chrome.toggleCollapsed(),
    onExpand: () => section.collapsible && section.collapsed && chrome.toggleCollapsed(),
  });
  const bodyId = `sidebar-section-${section.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const prefix = containerPrefix(section.id);
  const sectionId = ungroupedSectionId(section.id);
  const groupId = section.id.startsWith('group:') ? section.id.slice('group:'.length) : null;

  const rows = (
    <SidebarMenu id={bodyId}>
      {section.rows.map((row) => (
        <SidebarModelRow
          key={`${prefix}-${row.key}`}
          row={row}
          keyPrefix={prefix}
          {...(sectionId === undefined ? {} : { sectionId })}
        />
      ))}
    </SidebarMenu>
  );

  // Only the rows the model made drag sources register with dnd-kit, so it
  // never measures a node that has no `Sortable` around it.
  const draggableIds = section.rows.flatMap((row) => {
    if (!row.draggable) return [];
    const ref = dragRefOf(row.target);
    return ref === null ? [] : [sidebarRowDndId(prefix, ref)];
  });

  const header = (
    <SectionHeader
      label={section.label ?? ''}
      collapsed={section.collapsed}
      {...(section.collapsible ? { onToggle: chrome.toggleCollapsed, onToggleAll } : {})}
      controlsId={bodyId}
      level={isSubsection ? 4 : 3}
      nodes={chrome.menuNodes}
      actionsLabel={`${section.label ?? 'Section'} ${isSubsection ? 'group' : 'section'} actions`}
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
      // menu surface, so it needs a named group of its own to watch (R2's
      // "nothing renders at rest", with `focus-visible` and touch as the two
      // other paths).
      className={cn(
        'group/section px-0',
        // **One indent level, and it moves the whole section** — header AND
        // rows. `--sidebar-nested-x` lands a member's header at 24, its glyph at
        // 32 and its label at 58 (D1). It used to be 14px on the sub-header
        // alone, with the rows left flush: a nested list that reads as nested
        // only where nobody is looking.
        isSubsection && 'pl-[var(--sidebar-nested-x)]'
      )}
      // A stable handle for the page objects. `[data-slot="sidebar-group"]`
      // alone is ambiguous the moment a section nests: a group's wrapper sits
      // INSIDE the Agents wrapper, so a filter for "the group whose header says
      // X" matched the ancestor as well as the descendant and tripped strict
      // mode (the browser suite found this, not a reader).
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
              {...b.handleProps}
              className={cn(
                'focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2',
                b.isDragging && 'opacity-40',
                b.isOver && 'ring-sidebar-ring ring-2'
              )}
            >
              {header}
            </div>
          )}
        </Sortable>
      ) : (
        header
      )}
      {chrome.action}
      {chrome.dialogs}
      {!section.collapsed && (
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
      )}
      {!section.collapsed &&
        (section.subsections ?? []).map((sub) => (
          <SidebarSection key={sub.id} section={sub} onToggleAll={onToggleAll} isSubsection />
        ))}
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
  if (rollup.needsYouCount !== undefined) {
    // Only when there IS something to answer. A folded Heads up holding nothing
    // but "3 working" says "3" like anything else — claiming "0 need you" would
    // be an alarm about an absence.
    parts.push(rollup.needsYouCount > 0 ? `${rollup.needsYouCount} need you` : `${rollup.count}`);
  } else {
    parts.push(`${rollup.count}`);
  }
  if (rollup.unread.tier === 'directed' && (rollup.unread.count ?? 0) > 0) {
    parts.push(`${rollup.unread.count} unread`);
  } else if (rollup.unread.tier === 'activity') {
    // Tier one is a bold label and nothing else (design-decisions §18) — which
    // the header wears through `emphasized`. The word is here so a reader who
    // cannot see the weight is told the same thing.
    parts.push('unread');
  }
  if (rollup.workingCount > 0) parts.push(`${rollup.workingCount} working`);
  return <>{parts.join(' · ')}</>;
}
