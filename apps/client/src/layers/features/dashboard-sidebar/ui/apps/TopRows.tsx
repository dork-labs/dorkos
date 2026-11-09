/**
 * The top items' rows, with the Apps door's pinned apps grouped under it and
 * its notice (loading bars, or "Couldn't load apps") standing in their place
 * when they cannot be shown (DOR-3970).
 *
 * @module features/dashboard-sidebar/ui/apps/TopRows
 */
import type { ReactNode } from 'react';
import type { SidebarRowModel, SidebarSectionModel } from '../../model/build-sidebar-model';
import { AppsNoticeRow } from './AppsNoticeRow';

/** Props for {@link TopRows}. */
export interface TopRowsProps {
  /** The top section. */
  section: SidebarSectionModel;
  /** Draws one row, the way every other section's rows are drawn. */
  renderRow: (row: SidebarRowModel) => ReactNode;
}

/**
 * The top rows in order, the pins in one `role="group"` named "Pinned apps"
 * right after the door.
 *
 * @param props - The section and the row renderer.
 */
export function TopRows({ section, renderRow }: TopRowsProps) {
  const pinned = section.rows.filter((row) => row.app !== undefined);
  const out: ReactNode[] = [];
  for (const row of section.rows) {
    if (row.app !== undefined) continue;
    out.push(renderRow(row));
    if (row.target.kind !== 'command' || row.target.commandId !== 'open-apps') continue;
    if (section.appsNotice) {
      out.push(<AppsNoticeRow key="apps-notice" notice={section.appsNotice} />);
    } else if (pinned.length > 0) {
      out.push(
        <li key="apps-pinned" role="none">
          <ul role="group" aria-label="Pinned apps" className="flex flex-col gap-px">
            {pinned.map(renderRow)}
          </ul>
        </li>
      );
    }
  }
  return <>{out}</>;
}
