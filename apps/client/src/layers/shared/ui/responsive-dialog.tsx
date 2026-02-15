import * as React from 'react';
import { useIsMobile } from '../lib/use-is-mobile';
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

interface ResponsiveDialogProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const ResponsiveDialogContext = React.createContext<{ isDesktop: boolean }>({ isDesktop: true });

function ResponsiveDialog({ children, ...props }: ResponsiveDialogProps) {
  const isDesktop = !useIsMobile();
  const Comp = isDesktop ? Dialog : Drawer;
  return (
    <ResponsiveDialogContext.Provider value={{ isDesktop }}>
      <Comp {...props}>{children}</Comp>
    </ResponsiveDialogContext.Provider>
  );
}

function ResponsiveDialogTrigger({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogTrigger>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogTrigger : DrawerTrigger;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}

function ResponsiveDialogContent({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogContent>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  if (isDesktop) {
    return (
      <DialogContent className={cn('h-[75vh] flex flex-col', className)} {...props}>
        {children}
      </DialogContent>
    );
  }
  return (
    <DrawerContent className={cn('h-[90vh] flex flex-col', className)}>
      {children}
    </DrawerContent>
  );
}

function ResponsiveDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogHeader : DrawerHeader;
  return <Comp className={className} {...props} />;
}

function ResponsiveDialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogTitle>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogTitle : DrawerTitle;
  return <Comp className={className} {...props} />;
}

function ResponsiveDialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogDescription>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogDescription : DrawerDescription;
  return <Comp className={className} {...props} />;
}

function ResponsiveDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogFooter : DrawerFooter;
  return <Comp className={className} {...props} />;
}

function ResponsiveDialogClose({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogClose>) {
  const { isDesktop } = React.useContext(ResponsiveDialogContext);
  const Comp = isDesktop ? DialogClose : DrawerClose;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
};
