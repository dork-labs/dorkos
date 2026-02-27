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
import { cn } from '../lib/utils';

interface ResponsiveDialogContextValue {
  isDesktop: boolean;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
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

interface ResponsiveDialogProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Start in fullscreen mode when opened on desktop. Ignored on mobile. */
  defaultFullscreen?: boolean;
}

function ResponsiveDialog({
  children,
  defaultFullscreen = false,
  onOpenChange,
  ...props
}: ResponsiveDialogProps) {
  const isDesktop = !useIsMobile();
  const [isFullscreen, setIsFullscreen] = React.useState(defaultFullscreen);
  const Comp = isDesktop ? Dialog : Drawer;

  // Reset fullscreen state when dialog closes
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) setIsFullscreen(defaultFullscreen);
      onOpenChange?.(open);
    },
    [defaultFullscreen, onOpenChange]
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
    }),
    [isDesktop, isFullscreen, toggleFullscreen]
  );

  return (
    <ResponsiveDialogContext.Provider value={ctxValue}>
      <Comp {...props} onOpenChange={handleOpenChange}>
        {children}
      </Comp>
    </ResponsiveDialogContext.Provider>
  );
}
ResponsiveDialog.displayName = 'ResponsiveDialog';

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

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogContent>) {
  const { isDesktop, isFullscreen } = useResponsiveDialog();
  if (isDesktop) {
    return (
      <DialogContent
        data-fullscreen={isFullscreen || undefined}
        className={cn(
          'flex min-h-[50vh] flex-col overflow-hidden transition-all duration-300 ease-[cubic-bezier(0,0,0.2,1)]',
          'data-[fullscreen]:top-4 data-[fullscreen]:right-4 data-[fullscreen]:bottom-4 data-[fullscreen]:left-4',
          'data-[fullscreen]:translate-x-0 data-[fullscreen]:translate-y-0',
          'data-[fullscreen]:max-w-none data-[fullscreen]:max-h-none data-[fullscreen]:w-auto data-[fullscreen]:h-auto',
          className
        )}
        {...props}
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

function ResponsiveDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogHeader : DrawerHeader;
  // Desktop dialogs have absolute close/fullscreen buttons at top-right; pad to avoid overlap
  return <Comp className={cn(className, isDesktop && 'pr-14')} {...props} />;
}
ResponsiveDialogHeader.displayName = 'ResponsiveDialogHeader';

function ResponsiveDialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogTitle>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogTitle : DrawerTitle;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogTitle.displayName = 'ResponsiveDialogTitle';

function ResponsiveDialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogDescription>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogDescription : DrawerDescription;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogDescription.displayName = 'ResponsiveDialogDescription';

function ResponsiveDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = useResponsiveDialog();
  const Comp = isDesktop ? DialogFooter : DrawerFooter;
  return <Comp className={className} {...props} />;
}
ResponsiveDialogFooter.displayName = 'ResponsiveDialogFooter';

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

/** Scrollable body area for responsive dialog content. */
function ResponsiveDialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="responsive-dialog-body"
      className={cn('flex-1 overflow-y-auto px-4', className)}
      {...props}
    />
  );
}
ResponsiveDialogBody.displayName = 'ResponsiveDialogBody';

/** Fullscreen toggle button for desktop dialogs. Absolutely positioned next to the close button. Returns null on mobile. */
function ResponsiveDialogFullscreenToggle({ className }: { className?: string }) {
  const { isDesktop, isFullscreen, toggleFullscreen } = useResponsiveDialog();
  if (!isDesktop) return null;

  const Icon = isFullscreen ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      onClick={toggleFullscreen}
      className={cn(
        'ring-offset-background focus:ring-ring absolute top-4 right-12 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none',
        className
      )}
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      <Icon className="size-(--size-icon-md)" />
    </button>
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
};
