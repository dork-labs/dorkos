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
import { SectionHeader, SidebarGroup, SidebarMenu, statusDotClass } from '@/layers/shared/ui';
import type { SidebarSectionModel } from '../model/build-sidebar-model';
import type { SidebarContainer } from '../model/use-sidebar-dnd';
import { Droppable, Sortable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import { dragRefOf, SidebarModelRow } from './SidebarModelRow';
import { useSectionChrome } from './useSectionChrome';

/** What the drag layer calls each ungrouped section out loud. */
const SECTION_LABEL: Record<string, string> = {
  channels: 'Channels',
  dms: 'Direct messages',
  agents: 'Agents',
};

/**
 * The drag container a section's rows belong to.
 *
 * Pins is its own container; Channels, Direct messages and Agents are all
 * "ungrouped" — landing in any of them takes a row out of its group — and a
 * group is its own. Now, Today and Getting started are `computed`, which the
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
  return { kind: 'ungrouped', section: SECTION_LABEL[id] ?? 'Agents' };
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
  const sectionLabel = SECTION_LABEL[section.id];
  const groupId = section.id.startsWith('group:') ? section.id.slice('group:'.length) : null;

  const rows = (
    <SidebarMenu id={bodyId}>
      {section.rows.map((row) => (
        <SidebarModelRow
          key={`${prefix}-${row.key}`}
          row={row}
          keyPrefix={prefix}
          {...(sectionLabel === undefined ? {} : { sectionLabel })}
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
      {...(chrome.icon === undefined ? {} : { icon: chrome.icon })}
      collapsed={section.collapsed}
      {...(section.collapsible ? { onToggle: chrome.toggleCollapsed, onToggleAll } : {})}
      controlsId={bodyId}
      level={isSubsection ? 4 : 3}
      nodes={chrome.menuNodes}
      actionsLabel={`${section.label ?? 'Section'} ${isSubsection ? 'group' : 'section'} actions`}
      {...(chrome.hasSectionAction ? { hasSectionAction: true } : {})}
      {...(chrome.adornment === undefined ? {} : { adornment: chrome.adornment })}
      {...(chrome.editor === undefined ? {} : { editor: chrome.editor })}
      trailing={<SectionRollup section={section} />}
    />
  );

  return (
    <SidebarGroup className={cn('px-0', isSubsection && 'pl-[14px]')} {...roving}>
      {/* A headerless body — Now, Today, Getting started — is a zone's single
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
 * The signal a folded section keeps (BC-31).
 *
 * Renders nothing while the section is open — the rows say it better — and
 * nothing when there is nothing to say, so an idle folded section is a plain
 * label rather than a row of zeroes.
 *
 * @param props - The section.
 */
function SectionRollup({ section }: { section: SidebarSectionModel }) {
  const rollup = section.rollup;
  if (!section.collapsed || rollup === undefined) return null;
  const badge = rollup.unread.tier === 'directed' ? (rollup.unread.count ?? 0) : 0;
  if (badge === 0 && rollup.workingCount === 0 && rollup.unread.tier !== 'activity') return null;
  return (
    <>
      {rollup.workingCount > 0 && (
        <span
          role="img"
          aria-label={
            rollup.workingCount === 1 ? '1 agent working' : `${rollup.workingCount} agents working`
          }
          className={cn('size-1.5 shrink-0 rounded-full', statusDotClass('working'))}
        />
      )}
      {badge > 0 && (
        <span
          className="bg-brand/15 text-brand rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
          aria-label={`${badge} unread`}
        >
          {badge}
        </span>
      )}
      {badge === 0 && rollup.unread.tier === 'activity' && (
        // Tier one is a bold label and nothing else (design-decisions §18). A
        // folded header has no row to embolden, so it says so in words a screen
        // reader reads and a sighted reader never needs.
        <span className="sr-only">Unread messages inside</span>
      )}
    </>
  );
}
