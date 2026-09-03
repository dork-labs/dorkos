import { useMemo } from 'react';
import { cn } from '@/layers/shared/lib';
import { useTocScrollspy } from './lib/use-toc-scrollspy';
import type { PlaygroundSection } from './playground-registry';

interface TocSidebarProps {
  sections: PlaygroundSection[];
}

/** One run of consecutive sections that share a `category`. */
interface CategoryGroup {
  category: string;
  sections: PlaygroundSection[];
}

/**
 * Fold sections into consecutive same-`category` runs, preserving order.
 *
 * Section arrays are already authored in category order (every section file's
 * inline showcase comments mark the boundaries), so a run boundary is just a
 * change in `category` from the previous entry — no sorting or bucketing by
 * name, which would scatter a category that appears twice non-consecutively
 * instead of surfacing that as a sign the data needs reordering.
 */
function groupByCategory(sections: PlaygroundSection[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const section of sections) {
    const current = groups.at(-1);
    if (current && current.category === section.category) {
      current.sections.push(section);
    } else {
      groups.push({ category: section.category, sections: [section] });
    }
  }
  return groups;
}

/**
 * Sticky right-hand table of contents for playground pages.
 *
 * Highlights the active section using scroll-spy via IntersectionObserver.
 * Sections are grouped into sub-headings by consecutive `category` runs, so a
 * long page reads as a set of labeled clusters rather than one flat list.
 *
 * @param sections - Ordered list of sections to render as anchor links
 */
export function TocSidebar({ sections }: TocSidebarProps) {
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);
  const activeId = useTocScrollspy(sectionIds);
  const groups = useMemo(() => groupByCategory(sections), [sections]);

  return (
    <aside
      aria-label="Table of contents"
      className="sticky top-9 hidden h-fit w-44 shrink-0 xl:block"
    >
      <nav>
        <p className="text-foreground mb-2 text-xs font-medium">On this page</p>
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={`${group.category}-${group.sections[0]!.id}`}>
              <p className="text-muted-foreground mb-1 px-2 text-[10px] font-semibold tracking-wide uppercase">
                {group.category}
              </p>
              <ul className="space-y-0.5">
                {group.sections.map((section) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(section.id)?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'start',
                        });
                        history.replaceState(null, '', `#${section.id}`);
                      }}
                      className={cn(
                        'block truncate rounded px-2 py-1 text-xs transition-colors',
                        activeId === section.id
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                      )}
                    >
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  );
}
