import { useMemo } from 'react';
import { cn } from '@/layers/shared/lib';
import { useTocScrollspy } from './lib/use-toc-scrollspy';
import type { PlaygroundSection } from './playground-registry';

interface TocSidebarProps {
  sections: PlaygroundSection[];
}

/** All sections that share a `category`, in first-appearance order. */
interface CategoryGroup {
  category: string;
  sections: PlaygroundSection[];
}

/**
 * Group sections by `category`, keyed by name rather than position.
 *
 * A category's sections are not always authored consecutively — six pages
 * split the same category across non-adjacent positions (batch 20 audit
 * finding I2, DOR-1766) — so grouping only by "does this entry share its
 * predecessor's category" renders the same heading twice. Keying by name
 * instead means every category renders exactly one heading, positioned where
 * it first appears, with all of its sections listed underneath regardless of
 * where else in the array they occur.
 */
function groupByCategory(sections: PlaygroundSection[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  const byCategory = new Map<string, CategoryGroup>();
  for (const section of sections) {
    let group = byCategory.get(section.category);
    if (!group) {
      group = { category: section.category, sections: [] };
      byCategory.set(section.category, group);
      groups.push(group);
    }
    group.sections.push(section);
  }
  return groups;
}

/**
 * Sticky right-hand table of contents for playground pages.
 *
 * Highlights the active section using scroll-spy via IntersectionObserver.
 * Sections are grouped into sub-headings by `category`, so a long page reads
 * as a set of labeled clusters rather than one flat list. Scrolls internally
 * once its own height exceeds the viewport, so a long TOC never runs off the
 * bottom of the screen with nothing to reach the rest of it.
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
      className="sticky top-9 hidden max-h-[calc(100vh-3rem)] w-44 shrink-0 overflow-y-auto xl:block"
    >
      <nav>
        <p className="text-foreground mb-2 text-xs font-medium">On this page</p>
        <div className="space-y-3">
          {groups.map((group) => {
            const headingId = `toc-heading-${group.sections[0]!.id}`;
            return (
              <div key={headingId} role="group" aria-labelledby={headingId}>
                <p
                  id={headingId}
                  className="text-muted-foreground mb-1 px-2 text-[10px] font-semibold tracking-wide uppercase"
                >
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
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
