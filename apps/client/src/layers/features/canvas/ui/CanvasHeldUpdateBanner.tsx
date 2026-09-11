import { Button } from '@/layers/shared/ui';

interface CanvasHeldUpdateBannerProps {
  /** Take the agent's version (the store's `applyHeldUpdate`). */
  onReload: () => void;
  /** Throw the agent's version away and keep editing (`discardHeldUpdate`). */
  onKeepMine: () => void;
}

/**
 * The notice a person sees when an agent tried to change the document they are
 * editing — the half of ADR-0292 that was deferred when edit-protection landed.
 *
 * Edit-protection holds the agent's push so the editor stays the sole writer.
 * Until now it also said nothing: the agent was told "success", the person was
 * told nothing at all, and the push was gone. This is the missing sentence and
 * the choice that goes with it. It reads like the Files section's conflict
 * banner on purpose (`FilePreviewDialog`) — same shape, same register, same
 * trailing line saying what the quiet-looking button actually does — because it
 * is the same situation one surface over.
 *
 * `role="status"` rather than `alert`: nothing is wrong and nothing is urgent,
 * so it is announced politely and never takes focus. Rendered once, by the
 * canvas body, above whichever document is active, so it covers every content
 * type rather than only the two with editors today.
 */
export function CanvasHeldUpdateBanner({ onReload, onKeepMine }: CanvasHeldUpdateBannerProps) {
  return (
    <div
      role="status"
      className="border-border/60 bg-muted/40 mx-2 mt-2 space-y-2 rounded-md border px-3 py-2 text-sm"
    >
      <p>Your agent changed this while you were editing, so nothing here moved.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onReload}>
          Reload
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onKeepMine}>
          Keep mine
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Reload shows their version and ends your edit. Keep mine throws theirs away.
      </p>
    </div>
  );
}
