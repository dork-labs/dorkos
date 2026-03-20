import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/layers/shared/ui';
import type { Page, PlaygroundSection } from './playground-registry';
import { PLAYGROUND_REGISTRY } from './playground-registry';

/** Human-readable heading for each playground page. */
const PAGE_LABELS: Record<Page, string> = {
  overview: 'Overview',
  tokens: 'Design Tokens',
  forms: 'Forms',
  components: 'Components',
  chat: 'Chat',
  features: 'Features',
  simulator: 'Simulator',
};

/** Ordered list of pages for consistent group rendering. */
const PAGE_ORDER: Page[] = ['overview', 'tokens', 'forms', 'components', 'chat', 'features', 'simulator'];

/** Group registry sections by their page. */
function groupByPage(sections: PlaygroundSection[]): Map<Page, PlaygroundSection[]> {
  const grouped = new Map<Page, PlaygroundSection[]>();
  for (const section of sections) {
    const existing = grouped.get(section.page) ?? [];
    grouped.set(section.page, [...existing, section]);
  }
  return grouped;
}

interface PlaygroundSearchProps {
  /** Whether the search dialog is open. */
  open: boolean;
  /** Called when the dialog open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Called when the user selects a section to navigate to. */
  onSelect: (section: PlaygroundSection) => void;
}

/**
 * Cmd+K search dialog for navigating playground sections.
 *
 * Renders a command palette with all sections from `PLAYGROUND_REGISTRY`,
 * grouped by page with human-readable headings.
 */
export function PlaygroundSearch({ open, onOpenChange, onSelect }: PlaygroundSearchProps) {
  const grouped = React.useMemo(() => groupByPage(PLAYGROUND_REGISTRY), []);

  const handleSelect = React.useCallback(
    (section: PlaygroundSection) => {
      onSelect(section);
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* aria-describedby={undefined} suppresses Radix warning — no description needed for a search palette */}
      <DialogContent className="overflow-hidden p-0 shadow-modal" aria-describedby={undefined}>
        {/* sr-only title satisfies Radix accessibility requirement without visible heading */}
        <DialogTitle className="sr-only">Search playground sections</DialogTitle>
        <Command>
          <CommandInput placeholder="Search sections..." />
          <CommandList>
            <CommandEmpty>No sections found.</CommandEmpty>
            {PAGE_ORDER.map((page) => {
              const sections = grouped.get(page);
              if (!sections?.length) return null;
              return (
                <CommandGroup key={page} heading={PAGE_LABELS[page]}>
                  {sections.map((section) => (
                    <CommandItem
                      key={section.id}
                      value={[section.title, ...section.keywords].join(' ')}
                      onSelect={() => handleSelect(section)}
                    >
                      {section.title}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
