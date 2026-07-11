import { useRef } from 'react';
import { Plus, SquareTerminal, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useRovingTabList, type TabActivationSource } from '@/layers/shared/ui';

/** DOM id of the terminal content region the active tab controls. */
export const TERMINAL_PANEL_ID = 'terminal-panel';

/** Stable DOM id for a terminal's tab — links the panel `aria-labelledby` to it. */
export function terminalTabDomId(key: string): string {
  return `terminal-tab-${key}`;
}

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
  /**
   * Activate a tab by key. `source` tells the panel whether to focus the
   * revealed terminal: pointer clicks should land keystrokes in the shell,
   * keyboard traversal must keep focus on the strip.
   */
  onActivate: (key: string, source: TabActivationSource) => void;
  /** Close a tab by key. `source` has the same focus semantics as activation. */
  onClose: (key: string, source: TabActivationSource) => void;
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
 * Keyboard-accessible per the WAI-ARIA Tabs pattern (roving tabindex + arrow
 * navigation via {@link useRovingTabList}): one Tab stop for the whole strip,
 * arrow keys move and activate, and Delete closes the focused tab (falling back
 * to the "+" button when the last tab closes). The close control is a
 * non-tab-stop sibling of the tab (mouse/touch only) so the DOM stays valid,
 * and the "+" button sits outside the tablist as an ordinary Tab stop.
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
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const { getTabProps } = useRovingTabList({
    orderedIds: tabs.map((tab) => tab.key),
    activeId: activeKey,
    onActivate,
    onClose,
    // Delete on the last tab: land focus on the always-present "+" button —
    // the natural next action (spawn a terminal) — never the document body.
    getFallbackFocus: () => createButtonRef.current,
  });

  return (
    <div className="flex items-stretch overflow-x-auto border-b px-2 py-1">
      <div role="tablist" aria-label="Open terminals" className="flex items-stretch gap-1">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            // role="presentation" wrapper: ARIA expects tabs as direct tablist
            // children; this div exists only to anchor the absolutely-positioned
            // close control as a SIBLING of the tab (a button inside a button is
            // invalid HTML) — the same compromise VS Code ships.
            <div key={tab.key} role="presentation" className="group relative flex shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                id={terminalTabDomId(tab.key)}
                aria-controls={isActive ? TERMINAL_PANEL_ID : undefined}
                {...getTabProps(tab.key)}
                className={cn(
                  'focus-ring flex items-center gap-1.5 rounded-md py-1 pr-7 pl-2 text-xs transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <SquareTerminal className="size-3.5 shrink-0" />
                <span className="max-w-40 truncate font-medium">{tab.label}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onClose(tab.key, 'pointer')}
                aria-label={`Close ${tab.label}`}
                className="focus-ring hover:bg-background/80 absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        ref={createButtonRef}
        type="button"
        onClick={onCreate}
        aria-label="New terminal"
        title="New terminal"
        className="focus-ring text-muted-foreground hover:bg-muted/60 hover:text-foreground ml-1 flex shrink-0 items-center rounded-md px-1.5 py-1 transition-colors"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
