/**
 * A yes-or-no answer as two worded buttons under the row's body, the way the
 * Settings rows ask: the yes filled and first, the no quiet beside it.
 *
 * @module features/inbox/ui/InboxAnswerButtons
 */
import type { Ref } from 'react';
import { Button } from '@/layers/shared/ui';

/** Props for {@link InboxAnswerButtons}. */
export interface InboxAnswerButtonsProps {
  /** The yes, as an outcome: "Allow". */
  approveLabel: string;
  /** The no, as an outcome: "Not now". */
  rejectLabel: string;
  onApprove(): void;
  onReject(): void;
  /** Whether either answer is in flight. */
  disabled: boolean;
  /** The no button, so a closed note field can hand focus back to it. */
  rejectRef?: Ref<HTMLButtonElement>;
  /** Whether the no has opened a note field. */
  rejectExpanded?: boolean;
}

/**
 * Two worded answers, left-aligned: 32px tall on a desktop, 44px on a phone.
 *
 * @param props - {@link InboxAnswerButtonsProps}.
 */
export function InboxAnswerButtons({
  approveLabel,
  rejectLabel,
  onApprove,
  onReject,
  disabled,
  rejectRef,
  rejectExpanded,
}: InboxAnswerButtonsProps) {
  return (
    // On a phone the Inbox is a bottom sheet, and a long card would push its
    // answer below the fold: the buttons stay pinned to the sheet's bottom
    // while the card is on screen (designer, DOR-3293). The cover is the
    // sheet's own composite fill (its dark-mode lift), else the plain fill.
    <div
      className="mt-2 flex flex-wrap items-center gap-2 max-md:sticky max-md:bottom-0 max-md:bg-[var(--dui-scroll-cover,var(--color-popover))] max-md:py-2"
      data-slot="inbox-answer-buttons"
    >
      <Button type="button" size="sm" onClick={onApprove} disabled={disabled}>
        {approveLabel}
      </Button>
      <Button
        ref={rejectRef}
        type="button"
        size="sm"
        variant="secondary"
        onClick={onReject}
        disabled={disabled}
        {...(rejectExpanded !== undefined ? { 'aria-expanded': rejectExpanded } : {})}
      >
        {rejectLabel}
      </Button>
    </div>
  );
}
