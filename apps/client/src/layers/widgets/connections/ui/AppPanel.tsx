import { useState, type ReactNode } from 'react';
import { type YourAppRow, ServiceMark } from '@/layers/features/connections';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  Badge,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetTitle,
  STATUS_TONE_DOT,
} from '@/layers/shared/ui';

interface AppPanelProps {
  /** The row the panel is about; `null` while it loads. */
  row: YourAppRow | null;
  /** Whether the panel is open. */
  open: boolean;
  /** Close the panel. */
  onOpenChange: (open: boolean) => void;
  /**
   * Where focus goes when the panel closes. The panel opens from a row or a
   * link rather than a trigger of its own, so the page hands focus back.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /** The panel's body (an account's or a chat app's). */
  children: ReactNode;
}

/**
 * The side panel a connected app opens (design record §5): it slides in from
 * the right over the list on a desktop, and up from the bottom on a phone.
 * Its address lives in the page URL (`?app=`), so the chat card and any link
 * can open it directly.
 *
 * The shell draws only the app's name, which account it is, and whether it
 * works; the body decides everything else. Focus moves into the panel when it
 * opens and back to the row when it closes, and Escape closes it.
 */
export function AppPanel({ row, open, onOpenChange, onCloseAutoFocus, children }: AppPanelProps) {
  const requestedMobile = useIsMobile();
  // Fixed at each open, so a window resized mid-panel never swaps a sheet for
  // a drawer under the person's focus (the ResponsiveDialog rule).
  const [shape, setShape] = useState({ open, mobile: requestedMobile });
  let mobile = shape.mobile;
  if (shape.open !== open || (!open && shape.mobile !== requestedMobile)) {
    setShape({ open, mobile: requestedMobile });
    mobile = requestedMobile;
  }

  const header = row && (
    <div className="flex items-center gap-3 pr-8">
      <ServiceMark iconKey={row.iconKey} displayName={row.name} className="size-10 rounded-lg" />
      <div className="min-w-0 flex-1 text-left">
        <PanelTitle mobile={mobile} className="flex items-center gap-2 text-base font-semibold">
          <span className="truncate">{row.name}</span>
          {row.kind === 'chat' && (
            <Badge size="xs" variant="secondary">
              Chat
            </Badge>
          )}
        </PanelTitle>
        <PanelDescription
          mobile={mobile}
          className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
        >
          {row.account && (
            <span className="truncate">
              {row.identity ? `${row.account} · ${row.identity}` : row.account}
            </span>
          )}
          {row.tone === 'ready' && (
            <span className="flex shrink-0 items-center gap-1.5">
              {row.account && <span aria-hidden>·</span>}
              <span className={cn('size-2 rounded-full', STATUS_TONE_DOT.success)} aria-hidden />
              Connected
            </span>
          )}
        </PanelDescription>
      </div>
    </div>
  );
  const fallbackTitle = (
    <>
      <PanelTitle mobile={mobile} className="sr-only">
        App details
      </PanelTitle>
      <PanelDescription mobile={mobile} className="sr-only">
        Loading this app.
      </PanelDescription>
    </>
  );

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className="max-h-[88vh] outline-none"
          data-testid="app-panel"
          onOpenAutoFocus={focusPanel}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="px-4 pt-3 pb-3">{header ?? fallbackTitle}</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{children}</div>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange}>
      <ResponsiveSheetContent
        className="w-full gap-0 outline-none"
        data-testid="app-panel"
        onOpenAutoFocus={focusPanel}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="px-6 pt-5 pb-4">{header ?? fallbackTitle}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">{children}</div>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}

/**
 * Land focus on the panel itself rather than its first button, so opening a
 * panel never looks like a choice was pre-selected; Tab still starts at the top.
 */
function focusPanel(event: Event) {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.focus();
}

/** The panel's title, from the primitive the panel is drawn with. */
function PanelTitle({
  mobile,
  className,
  children,
}: {
  mobile: boolean;
  className?: string;
  children: ReactNode;
}) {
  return mobile ? (
    <DrawerTitle className={className}>{children}</DrawerTitle>
  ) : (
    <ResponsiveSheetTitle className={className}>{children}</ResponsiveSheetTitle>
  );
}

/** The panel's one-line description, from the primitive the panel is drawn with. */
function PanelDescription({
  mobile,
  className,
  children,
}: {
  mobile: boolean;
  className?: string;
  children: ReactNode;
}) {
  return mobile ? (
    <DrawerDescription className={className}>{children}</DrawerDescription>
  ) : (
    <ResponsiveSheetDescription className={className}>{children}</ResponsiveSheetDescription>
  );
}
