import * as React from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useIsMobile } from '../model';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
import { cn } from '@/layers/shared/lib/utils';
import { Button } from './button';

interface ResponsiveDialogContextValue {
  isDesktop: boolean;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  /** True when a ResponsiveDialogFullscreenToggle is mounted. */
  hasFullscreenToggle: boolean;
  /** @internal Called by ResponsiveDialogFullscreenToggle on mount. */
  registerFullscreenToggle: () => () => void;
}

const ResponsiveDialogContext = React.createContext<ResponsiveDialogContextValue | undefined>(
  undefined
);

/** Read responsive dialog context. Throws if used outside a `ResponsiveDialog`. */
function useResponsiveDialog(): ResponsiveDialogContextValue {
  const ctx = React.useContext(ResponsiveDialogContext);
  if (!ctx) {
    throw new Error('useResponsiveDialog must be used within a <ResponsiveDialog>');
  }
  return ctx;
}

/**
 * Read responsive dialog context without throwing outside a `ResponsiveDialog`.
 *
 * For headers that compose over more than one dialog shell — `NavigationLayoutDialogHeader`
 * is tested standalone (no `ResponsiveDialog` ancestor) as well as mounted inside one by
 * `TabbedDialog` — and needs to know whether a fullscreen toggle exists only in the latter
 * case.
 */
function useResponsiveDialogOptional(): ResponsiveDialogContextValue | undefined {
  return React.useContext(ResponsiveDialogContext);
}

export interface ResponsiveDialogProps {
  children: React.ReactNode;
  open?: boolean;
  /** Open on the first render when the dialog is not controlled by `open`. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Start in fullscreen mode when opened on desktop. Ignored on mobile. */
  defaultFullscreen?: boolean;
}

/** Renders a dialog on desktop or a drawer on mobile with shared context. */
function ResponsiveDialog({
  children,
  defaultOpen = false,
  defaultFullscreen = false,
  onOpenChange,
  ...props
}: ResponsiveDialogProps) {
  const requestedIsDesktop = !useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = props.open ?? uncontrolledOpen;
  // Capture the primitive at each open/close boundary. While open, a breakpoint
  // change must not replace Radix Dialog with Vaul Drawer underneath the user's
  // focus. While closed, keep following the viewport so the next open uses the
  // right primitive. React supports this guarded render-time adjustment for
  // state derived from a prop transition; an effect would add a stale render.
  const [primitiveState, setPrimitiveState] = React.useState({
    open,
    isDesktop: requestedIsDesktop,
  });
  let isDesktop = primitiveState.isDesktop;
  if (primitiveState.open !== open || (!open && primitiveState.isDesktop !== requestedIsDesktop)) {
    const nextPrimitiveState = { open, isDesktop: requestedIsDesktop };
    setPrimitiveState(nextPrimitiveState);
    isDesktop = nextPrimitiveState.isDesktop;
  }
  const [isFullscreen, setIsFullscreen] = React.useState(defaultFullscreen);
  const [hasFullscreenToggle, setHasFullscreenToggle] = React.useState(false);

  const registerFullscreenToggle = React.useCallback(() => {
    setHasFullscreenToggle(true);
    return () => setHasFullscreenToggle(false);
  }, []);

  // Reset fullscreen state when dialog closes
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (props.open === undefined) setUncontrolledOpen(open);
      if (!open) {
        setIsFullscreen(defaultFullscreen);
      }
      onOpenChange?.(open);
    },
    [defaultFullscreen, onOpenChange, props.open]
  );

  const toggleFullscreen = React.useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  const ctxValue = React.useMemo<ResponsiveDialogContextValue>(
    () => ({
      isDesktop,
      // Fullscreen is always false on mobile (drawer is near-fullscreen already)
      isFullscreen: isDesktop ? isFullscreen : false,
      toggleFullscreen,
      hasFullscreenToggle,
      registerFullscreenToggle,
    }),
    [isDesktop, isFullscreen, toggleFullscreen, hasFullscreenToggle, registerFullscreenToggle]
  );

  return (
    <ResponsiveDialogContext.Provider value={ctxValue}>
      {isDesktop ? (
        <Dialog {...props} open={open} onOpenChange={handleOpenChange}>
          {children}
        </Dialog>
      ) : (
        <Drawer {...props} open={open} onOpenChange={handleOpenChange}>
          {children}
        </Drawer>
      )}
    </ResponsiveDialogContext.Provider>
  );
}
ResponsiveDialog.displayName = 'ResponsiveDialog';

/** Trigger element that opens the responsive dialog or drawer. */
function ResponsiveDialogTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogTrigger>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogTrigger : DrawerTrigger;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}
ResponsiveDialogTrigger.displayName = 'ResponsiveDialogTrigger';

/** Props for {@link ResponsiveDialogContent}. */
export interface ResponsiveDialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogContent
> {
  /**
   * Props for the centered-dialog shape only — a width cap, an open-focus
   * handler — merged over the rest (`className` joins rather than replaces).
   *
   * Decided by the dialog's OWN shape, which is fixed when it opens, never by a
   * live viewport read: a caller that asked `useIsMobile()` instead would hand
   * a drawer the desktop's props the moment the window was resized under it.
   */
  desktopProps?: Partial<React.ComponentPropsWithoutRef<typeof DialogContent>>;
}

/** Content panel that renders as a centered dialog or bottom drawer based on viewport. */
function ResponsiveDialogContent({
  className,
  children,
  desktopProps,
  ...props
}: ResponsiveDialogContentProps) {
  const { isDesktop, isFullscreen } = useResponsiveDialog();
  if (isDesktop) {
    const { className: desktopClassName, ...desktopRest } = desktopProps ?? {};
    return (
      <DialogContent
        data-fullscreen={isFullscreen || undefined}
        className={cn(
          'flex min-h-[50vh] flex-col overflow-hidden transition-[top,right,bottom,left,translate] duration-300 ease-[cubic-bezier(0,0,0.2,1)]',
          'data-[fullscreen]:top-4 data-[fullscreen]:right-4 data-[fullscreen]:bottom-4 data-[fullscreen]:left-4',
          'data-[fullscreen]:translate-x-0 data-[fullscreen]:translate-y-0',
          'data-[fullscreen]:h-auto data-[fullscreen]:max-h-none data-[fullscreen]:w-auto data-[fullscreen]:max-w-none',
          className,
          desktopClassName
        )}
        {...props}
        {...desktopRest}
      >
        {children}
      </DialogContent>
    );
  }
  return (
    <DrawerContent className={cn('flex flex-col', className)} {...props}>
      {children}
    </DrawerContent>
  );
}
ResponsiveDialogContent.displayName = 'ResponsiveDialogContent';

/** Header layout for the responsive dialog, with padding to avoid close button overlap on desktop. */
function ResponsiveDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop, hasFullscreenToggle } = useResponsiveDialog();
  const Comp = isDesktop ? DialogHeader : DrawerHeader;
  // Desktop dialogs always park the dialog's own close button in the top-right
  // corner — `pr-14` clears that alone. When a caller also mounts a
  // ResponsiveDialogFullscreenToggle, it registers itself here and the
  // reservation grows to `pr-20`, measured from the far edge of the OUTER
  // control: the toggle sits at `right-12` and is 32px wide, so it reaches
  // 80px in. `pr-14` left the toggle standing on top of a long title. The 19
  // no-toggle callers keep `pr-14` — widening every desktop dialog for a
  // control most of them never mount would cost real title/description width
  // for nothing.
  return (
    <Comp
      className={cn(className, isDesktop && (hasFullscreenToggle ? 'pr-20' : 'pr-14'))}
      {...props}
    />
  );
}
ResponsiveDialogHeader.displayName = 'ResponsiveDialogHeader';

/** Title heading for the responsive dialog or drawer. */
function ResponsiveDialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogTitle>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogTitle : DrawerTitle;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogTitle.displayName = 'ResponsiveDialogTitle';

/** Description text for the responsive dialog or drawer. */
function ResponsiveDialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogDescription>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogDescription : DrawerDescription;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogDescription.displayName = 'ResponsiveDialogDescription';

/** Footer layout for responsive dialog action buttons. */
function ResponsiveDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogFooter : DrawerFooter;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogFooter.displayName = 'ResponsiveDialogFooter';

/** Close button for the responsive dialog or drawer. */
function ResponsiveDialogClose({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogClose>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogClose : DrawerClose;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}
ResponsiveDialogClose.displayName = 'ResponsiveDialogClose';

/** Props for {@link ResponsiveDialogBody}. */
export interface ResponsiveDialogBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Line the body's content up with the header on the centered dialog. The body
   * keeps its `px-4` (the room a field's 3px focus ring needs inside a scroll
   * region, DOR-2076) and hands the dialog's matching gutter back with `-mx-4`.
   * The drawer pays no side padding of its own, so its body already lines up,
   * and gets nothing. Read off the dialog's own shape, fixed at open.
   */
  alignWithHeader?: boolean;
}

/** Scrollable body area for responsive dialog content. */
function ResponsiveDialogBody({ className, alignWithHeader, ...props }: ResponsiveDialogBodyProps) {
  // Optional: a body mounted outside a ResponsiveDialog simply never aligns.
  const isDesktop = useResponsiveDialogOptional()?.isDesktop ?? false;
  return (
    <div
      data-slot="responsive-dialog-body"
      className={cn(
        'flex-1 overflow-y-auto px-4',
        alignWithHeader && isDesktop && '-mx-4',
        className
      )}
      {...props}
    />
  );
}
ResponsiveDialogBody.displayName = 'ResponsiveDialogBody';

/** Fullscreen toggle button for desktop dialogs. Absolutely positioned next to the close button. Returns null on mobile. */
function ResponsiveDialogFullscreenToggle({ className }: { className?: string }) {
  const { isDesktop, isFullscreen, toggleFullscreen, registerFullscreenToggle } =
    useResponsiveDialog();

  // Registered unconditionally, before the desktop check below: callers mount
  // this element unconditionally (it decides for itself whether to render),
  // and the headers that need to clear it care whether one exists at all, not
  // whether the viewport happens to be desktop on this render.
  React.useLayoutEffect(() => registerFullscreenToggle(), [registerFullscreenToggle]);

  if (!isDesktop) return null;

  const Icon = isFullscreen ? Minimize2 : Maximize2;
  return (
    // `Button`, which brings the `focus-visible:` ring this control had as a
    // bare `focus:` — a ring that fired on every mouse click as well.
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleFullscreen}
      className={cn('absolute top-4 right-12 opacity-70 hover:opacity-100', className)}
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      <Icon className="size-(--size-icon-md)" />
    </Button>
  );
}
ResponsiveDialogFullscreenToggle.displayName = 'ResponsiveDialogFullscreenToggle';

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  ResponsiveDialogBody,
  ResponsiveDialogFullscreenToggle,
  useResponsiveDialog,
  useResponsiveDialogOptional,
};
