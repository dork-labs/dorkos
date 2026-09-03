import { isMac } from '@/layers/shared/lib';

interface PaletteFooterProps {
  /** Current cmdk page (undefined for root) */
  page: string | undefined;
  /** Whether an agent item is currently selected (desktop only) */
  hasAgentSelected: boolean;
  /** Whether the highlighted row is something the palette can be scoped to. */
  canScope: boolean;
  /** Whether a scope chip is up. */
  isScoped: boolean;
}

const KBD_CLASS = 'bg-muted rounded px-1 py-0.5 font-mono text-3xs' as const;

/**
 * Dynamic keyboard hint bar at the bottom of the command palette.
 *
 * Shows context-appropriate shortcuts based on the current page
 * and selection state. Agent-specific hints (Enter/Cmd+Enter) are
 * hidden on mobile since the preview panel isn't visible.
 *
 * This bar is where the scope chip's two keystrokes are told. Neither has any
 * other affordance — Tab picks a chip up, Backspace puts it down — and a
 * shortcut nobody is told about is folklore (spec `rooms` §14.5). Each appears
 * only in the state where it does something.
 *
 * **"Clear scope, at the start" names its condition rather than appearing and
 * disappearing with the caret**, and that is a decision. Backspace clears the
 * scope only with the caret before everything; anywhere else it deletes a
 * character, so the bare words "Clear scope" were a lie for most of the time a
 * chip was up. The honest alternative was to make the hint reactive — a
 * `selectionchange` listener flipping it on and off as the caret moves — and it
 * was rejected twice over: it re-renders the palette on every arrow key, and a
 * hint that blinks in and out teaches nobody the rule it is trying to teach.
 * Saying the condition is true in every state and is the only version a person
 * can act on.
 *
 * @param page - Current cmdk page name (undefined for root)
 * @param hasAgentSelected - Whether an agent item is currently selected
 * @param canScope - Whether the highlighted row can be scoped to
 * @param isScoped - Whether a scope chip is up
 */
export function PaletteFooter({ page, hasAgentSelected, canScope, isScoped }: PaletteFooterProps) {
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
      {canScope && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>Tab</kbd>
          Search inside
        </span>
      )}
      {isScoped && (
        <span className="inline-flex items-center gap-1">
          <kbd className={KBD_CLASS}>Backspace</kbd>
          Clear scope, at the start
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-1">
        <kbd className={KBD_CLASS}>esc</kbd>
        Close
      </span>
    </div>
  );
}
