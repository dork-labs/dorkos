/**
 * Slide-out setup guide panel for adapter configuration.
 *
 * Renders the adapter's setupGuide markdown content in a Sheet
 * that opens from the right side of the viewport, alongside the
 * wizard dialog. Triggered by a "Setup Guide" button in ConfigureStep.
 */
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/layers/shared/ui/sheet';
import { MarkdownContent } from '@/layers/shared/ui/markdown-content';
import { BookOpen } from 'lucide-react';

interface SetupGuideSheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Callback when the open state changes (e.g., user clicks overlay or close button). */
  onOpenChange: (open: boolean) => void;
  /** Adapter display name used in the sheet title (e.g., "Slack"). */
  title: string;
  /** Full markdown content of the setup guide. */
  content: string;
}

/** Slide-out panel rendering an adapter's setup guide markdown. */
export function SetupGuideSheet({ open, onOpenChange, title, content }: SetupGuideSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BookOpen className="size-4" />
            {title} Setup Guide
          </SheetTitle>
          <SheetDescription>
            Step-by-step instructions for configuring this adapter.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 px-4">
          <MarkdownContent content={content} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
