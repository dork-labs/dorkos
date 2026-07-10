import { Plus, SquareTerminal, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/** A single terminal tab, as the strip needs to render it. */
export interface TerminalTabDescriptor {
  /** Stable client key (React key + active tracking). */
  key: string;
  /** Display label, e.g. `Terminal 1`. */
  label: string;
}

interface TerminalTabsProps {
  /** Open terminals, in tab order. */
  tabs: TerminalTabDescriptor[];
  /** Key of the active tab. */
  activeKey: string | null;
  /** Activate a tab by key. */
  onActivate: (key: string) => void;
  /** Close a tab by key. */
  onClose: (key: string) => void;
  /** Create a new terminal (appended and activated). */
  onCreate: () => void;
}

/**
 * Terminal tab strip — the Terminal panel's own content chrome, rendered below
 * the container-owned shared header. One tab per live terminal (icon, label,
 * close button; the active tab highlighted) plus a trailing "+" to spawn
 * another. Mirrors the Canvas document-tab strip's interaction idioms
 * (append-and-activate, per-tab close, active highlight) so the two strips feel
 * identical (DOR-226).
 *
 * @module features/terminal/ui/TerminalTabs
 */
export function TerminalTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onCreate,
}: TerminalTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Open terminals"
      className="flex items-stretch gap-1 overflow-x-auto border-b px-2 py-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            className={cn(
              'group flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-xs transition-colors',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.key)}
              className="focus-ring flex items-center gap-1.5 rounded-sm"
            >
              <SquareTerminal className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate font-medium">{tab.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.key)}
              aria-label={`Close ${tab.label}`}
              className="focus-ring hover:bg-background/80 rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onCreate}
        aria-label="New terminal"
        title="New terminal"
        className="focus-ring text-muted-foreground hover:bg-muted/60 hover:text-foreground flex shrink-0 items-center rounded-md px-1.5 py-1 transition-colors"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
