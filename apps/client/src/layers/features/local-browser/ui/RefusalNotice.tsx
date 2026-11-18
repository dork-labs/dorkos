import { X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import type { RefusalNotice as RefusalNoticeCopy } from '../lib/refusal-notice';

/** Props for {@link RefusalNotice}. */
interface RefusalNoticeProps {
  notice: RefusalNoticeCopy;
  /** Runs the notice's one button. */
  onAction: () => void;
  /** Hides it for this page; the next refused page shows it again. */
  onDismiss: () => void;
  disabled?: boolean;
}

/**
 * A site refusing the in-app browser (DOR-4097), on the chrome's notice line. Neutral,
 * never error red, and still: the page under it must not jump. The site's name wraps
 * rather than being cut, and on a phone the button drops below the words.
 */
export function RefusalNotice({ notice, onAction, onDismiss, disabled }: RefusalNoticeProps) {
  return (
    <div
      role="status"
      data-slot="browser-refusal-notice"
      className="text-foreground flex shrink-0 items-center gap-1 px-2.5 py-1 text-xs"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 basis-48 break-words">{notice.text}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onAction}
          className="min-h-11 md:min-h-7"
        >
          {notice.action.label}
        </Button>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="size-11 shrink-0 md:size-7"
      >
        <X aria-hidden className="size-4" />
      </Button>
    </div>
  );
}
