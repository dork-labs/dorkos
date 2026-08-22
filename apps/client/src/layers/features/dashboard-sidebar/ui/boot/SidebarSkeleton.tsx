/**
 * What the panel shows while it is still finding out (spec
 * `sidebar-simplification` D6).
 *
 * **It reserves, it does not entertain.** Three section headers and eight rows
 * at exactly the geometry the real panel uses, so when the real rows arrive
 * nothing under the operator's pointer moves. It says nothing to a screen
 * reader — `aria-busy` on the panel's `<nav>` is the whole announcement, and a
 * live region reading out bones would be noise about nothing.
 *
 * @module features/dashboard-sidebar/ui/SidebarSkeleton
 */
import { SECTION_HEADER_INSET, Skeleton, SidebarMenuSkeleton } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/**
 * How many rows stand under each header bone.
 *
 * Eight rows in three groups, which is what a real panel looks like above the
 * fold on a laptop: a short Heads up or Today, then two longer Library
 * sections. The shape matters more than the count — the eye is measuring the
 * panel's rhythm, and three equal blocks would read as a placeholder.
 */
const ROWS_PER_SECTION = [2, 3, 3] as const;

/** How wide each header's label bone is, so the three do not look stamped. */
const HEADER_WIDTHS = ['w-14', 'w-10', 'w-16'] as const;

/** The panel's boot skeleton. */
export function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-1" data-testid="sidebar-skeleton" aria-hidden>
      {ROWS_PER_SECTION.map((rows, section) => (
        <div key={HEADER_WIDTHS[section]} className="flex flex-col">
          {/* The header bone sits on the same 28px line and the same
              `--sidebar-header-x` as a real `SectionHeader`; 10px of bone
              under an 11px label. */}
          <div className={cn('flex h-7 items-center', SECTION_HEADER_INSET)}>
            <Skeleton className={cn('h-2.5 rounded-sm', HEADER_WIDTHS[section])} />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <SidebarMenuSkeleton key={row} showIcon />
          ))}
        </div>
      ))}
    </div>
  );
}
