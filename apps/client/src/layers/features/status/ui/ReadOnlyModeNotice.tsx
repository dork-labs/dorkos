/**
 * "It can read but not change" — the one line that stops a read-only session
 * from looking like a broken agent (DOR-2019).
 *
 * Appearance only. WHETHER to draw it is {@link useReadOnlyModeHint}'s answer,
 * for the reason `PermissionPrimer` gives: the zone above the composer
 * arbitrates one card at a time and has to know who qualifies before it renders
 * anybody.
 *
 * @module features/status/ui/ReadOnlyModeNotice
 */
import { useEffect } from 'react';
import { Lock } from 'lucide-react';
import { Button, Card } from '@/layers/shared/ui';
import { useSessionPermissionPicker } from '../model/permission-picker-store';

/** What the notice needs from its caller. */
export interface ReadOnlyModeNoticeProps {
  /** The runtime's friendly name, e.g. `'Codex'`. */
  runtimeLabel: string;
  /**
   * Report that this card reached the screen.
   *
   * The slot above the composer shows one card at a time, so qualifying is not
   * the same as being seen — and the "said once" rule must count what was said,
   * not what was nearly said.
   */
  onShown?: () => void;
  /** Never show it again in this session. */
  onDismiss: () => void;
}

/**
 * The read-only explanation, drawn as one quiet card above the composer.
 *
 * The padlock, not an alarm colour: this is the safest setting on offer and the
 * card is here to explain it, not to warn about it (the same rule the dial's own
 * "Limited" affordance follows).
 *
 * **The way through to the picker is offered only when there IS one.** The
 * status line is budgeted by width and drops what does not fit out of the DOM
 * entirely, so on a phone the permission item is routinely absent
 * (`applyStatusBudget`). The picker publishes whether it is mounted
 * (`permission-picker-store`), and without one the card says the fact and
 * offers only the dismissal — a sentence with no button beats a button that
 * does nothing.
 *
 * @param props - The runtime's name and the two answers.
 */
export function ReadOnlyModeNotice({ runtimeLabel, onShown, onDismiss }: ReadOnlyModeNoticeProps) {
  const pickerAvailable = useSessionPermissionPicker((s) => s.available);
  const openPicker = useSessionPermissionPicker((s) => s.setOpen);
  useEffect(() => {
    onShown?.();
  }, [onShown]);

  return (
    <Card
      data-slot="read-only-mode-notice"
      data-testid="read-only-mode-notice"
      gap="none"
      // No outer margin: BottomSlot owns the spacing around whichever card wins
      // the slot (DOR-1759), so a card carrying its own would double it.
      className="flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    >
      <Lock className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        In this mode {runtimeLabel} can read files but not change them. Ask for a change and it will
        say no, with nothing for you to approve.
      </p>
      {/* Its own line under the words on a phone, beside them from `sm` up —
          the same shape `PermissionPrimer` uses, for the same reason: the two
          buttons take most of a narrow zone's width and clip their labels when
          squeezed in beside the sentence. */}
      <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
        <Button
          variant="ghost"
          size="sm"
          responsive={false}
          className="h-7 px-2 text-xs"
          onClick={onDismiss}
        >
          Got it
        </Button>
        {pickerAvailable && (
          <Button
            variant="outline"
            size="sm"
            responsive={false}
            className="h-7 px-2 text-xs"
            onClick={() => openPicker(true)}
          >
            Change permissions
          </Button>
        )}
      </div>
    </Card>
  );
}
