import { cn } from '@/layers/shared/lib';
import { useTocScrollspy } from './lib/use-toc-scrollspy';
import type { PlaygroundSection } from './playground-registry';

interface TocSidebarProps {
  sections: PlaygroundSection[];
}

/**
 * Sticky right-hand table of contents for playground pages.
 *
 * Highlights the active section using scroll-spy via IntersectionObserver.
 *
 * @param sections - Ordered list of sections to render as anchor links
 */
export function TocSidebar({ sections }: TocSidebarProps) {
  const sectionIds = sections.map((s) => s.id);
  const activeId = useTocScrollspy(sectionIds);

  return (
    <aside
      aria-label="Table of contents"
      className="sticky top-9 hidden h-fit w-44 shrink-0 xl:block"
    >
      <nav>
        <p className="text-foreground mb-2 text-xs font-medium">On this page</p>
        <ul className="space-y-0.5">
          {sections.map((section) => (
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
      </nav>
    </aside>
  );
}
