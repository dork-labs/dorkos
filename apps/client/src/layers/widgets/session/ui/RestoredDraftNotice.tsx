import { History } from 'lucide-react';
import { Button, Notice } from '@/layers/shared/ui';

/** The line a restored draft carries (spec `turns-survive-restarts` §7.4). */
export const RESTORED_DRAFT_LINE = 'DorkOS restarted. This message may not have been seen.';

/**
 * The line above a restored draft in the composer: the words below came back
 * after a restart. Send uses them up; Discard drops them on every window.
 */
export function RestoredDraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Notice role="status" aria-live="polite" className="mb-2 flex items-start gap-2">
      {/* mt-0.5 centres the 16px icon on the first 20px line, at any width. */}
      <History aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">{RESTORED_DRAFT_LINE}</p>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={onDiscard}>
        Discard draft
      </Button>
    </Notice>
  );
}
