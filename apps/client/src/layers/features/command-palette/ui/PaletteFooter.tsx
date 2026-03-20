import { isMac } from '@/layers/shared/lib';

interface PaletteFooterProps {
  /** Current cmdk page (undefined for root) */
  page: string | undefined;
  /** Whether an agent item is currently selected (desktop only) */
  hasAgentSelected: boolean;
}

const KBD_CLASS = 'bg-muted rounded px-1 py-0.5 font-mono text-[10px]' as const;

/**
 * Dynamic keyboard hint bar at the bottom of the command palette.
 *
 * Shows context-appropriate shortcuts based on the current page
 * and selection state. Agent-specific hints (Enter/Cmd+Enter) are
 * hidden on mobile since the preview panel isn't visible.
 *
 * @param page - Current cmdk page name (undefined for root)
 * @param hasAgentSelected - Whether an agent item is currently selected
 */
export function PaletteFooter({ page, hasAgentSelected }: PaletteFooterProps) {
  const modKey = isMac ? '\u2318' : 'Ctrl';

  return (
    <div className="text-muted-foreground flex flex-shrink-0 items-center gap-3 border-t px-3 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>{'\u2191\u2193'}</kbd>
        Navigate
      </span>
      {!page && hasAgentSelected && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>Enter</kbd>
          Open
        </span>
      )}
      {((!page && hasAgentSelected) || page === 'agent-actions') && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>{modKey}Enter</kbd>
          New Tab
        </span>
      )}
      {page === 'agent-actions' && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>Enter</kbd>
          Select
        </span>
      )}
      {page && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>Backspace</kbd>
          Back
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>esc</kbd>
        Close
      </span>
    </div>
  );
}
