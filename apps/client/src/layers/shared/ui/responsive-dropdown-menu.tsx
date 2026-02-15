import * as React from 'react';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useIsMobile } from '../model';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './dropdown-menu';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
import { cn } from '../lib/utils';

const ResponsiveDropdownMenuContext = React.createContext<{
  isDesktop: boolean;
  close: () => void;
}>({
  isDesktop: true,
  close: () => {},
});

// --- Root ---

interface ResponsiveDropdownMenuProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ResponsiveDropdownMenu({
  children,
  open: controlledOpen,
  onOpenChange,
}: ResponsiveDropdownMenuProps) {
  const isDesktop = !useIsMobile();
  const [internalOpen, setInternalOpen] = React.useState(false);

  const drawerOpen = controlledOpen ?? internalOpen;
  const handleDrawerOpenChange = React.useCallback(
    (v: boolean) => {
      setInternalOpen(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );

  const close = React.useCallback(() => {
    handleDrawerOpenChange(false);
  }, [handleDrawerOpenChange]);

  if (isDesktop) {
    return (
      <ResponsiveDropdownMenuContext.Provider value={{ isDesktop, close }}>
        <DropdownMenu open={controlledOpen} onOpenChange={onOpenChange}>
          {children}
        </DropdownMenu>
      </ResponsiveDropdownMenuContext.Provider>
    );
  }

  return (
    <ResponsiveDropdownMenuContext.Provider value={{ isDesktop, close }}>
      <Drawer open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
        {children}
      </Drawer>
    </ResponsiveDropdownMenuContext.Provider>
  );
}

// --- Trigger ---

function ResponsiveDropdownMenuTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuTrigger>) {
  const { isDesktop } = React.useContext(ResponsiveDropdownMenuContext);
  const Comp = isDesktop ? DropdownMenuTrigger : DrawerTrigger;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}

// --- Content ---

function ResponsiveDropdownMenuContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuContent>) {
  const { isDesktop } = React.useContext(ResponsiveDropdownMenuContext);
  if (isDesktop) {
    return (
      <DropdownMenuContent className={className} {...props}>
        {children}
      </DropdownMenuContent>
    );
  }
  return (
    <DrawerContent>
      <div className="pb-6">{children}</div>
    </DrawerContent>
  );
}

// --- Label ---

function ResponsiveDropdownMenuLabel({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuLabel>) {
  const { isDesktop } = React.useContext(ResponsiveDropdownMenuContext);
  if (isDesktop) {
    return (
      <DropdownMenuLabel className={className} {...props}>
        {children}
      </DropdownMenuLabel>
    );
  }
  return (
    <DrawerHeader className="pb-2">
      <DrawerTitle className={cn('text-sm font-semibold text-muted-foreground', className)}>
        {children}
      </DrawerTitle>
    </DrawerHeader>
  );
}

// --- RadioGroup ---

interface ResponsiveDropdownMenuRadioGroupProps {
  value?: string;
  onValueChange?: (value: string) => void;
  /** Close the drawer after selecting an item on mobile. Defaults to true. No-op on desktop. */
  closeOnSelect?: boolean;
  children: React.ReactNode;
  className?: string;
}

const RadioGroupContext = React.createContext<{
  value?: string;
  onValueChange?: (value: string) => void;
  closeOnSelect: boolean;
}>({ closeOnSelect: true });

function ResponsiveDropdownMenuRadioGroup({
  value,
  onValueChange,
  closeOnSelect = true,
  children,
  className,
}: ResponsiveDropdownMenuRadioGroupProps) {
  const { isDesktop } = React.useContext(ResponsiveDropdownMenuContext);
  if (isDesktop) {
    return (
      <DropdownMenuRadioGroup value={value} onValueChange={onValueChange} className={className}>
        {children}
      </DropdownMenuRadioGroup>
    );
  }
  return (
    <RadioGroupContext.Provider value={{ value, onValueChange, closeOnSelect }}>
      <div role="radiogroup" className={cn('flex flex-col', className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

// --- RadioItem ---

interface ResponsiveDropdownMenuRadioItemProps {
  value: string;
  children: React.ReactNode;
  icon?: LucideIcon;
  description?: string;
  className?: string;
}

function ResponsiveDropdownMenuRadioItem({
  value,
  children,
  icon: Icon,
  description,
  className,
}: ResponsiveDropdownMenuRadioItemProps) {
  const { isDesktop } = React.useContext(ResponsiveDropdownMenuContext);

  if (isDesktop) {
    return (
      <DropdownMenuRadioItem value={value} className={className}>
        {Icon || description ? (
          <div className="flex items-center gap-2">
            {Icon && <Icon className="size-(--size-icon-xs) shrink-0" />}
            <div className="text-left">
              <div>{children}</div>
              {description && (
                <div className="text-[10px] text-muted-foreground">{description}</div>
              )}
            </div>
          </div>
        ) : (
          children
        )}
      </DropdownMenuRadioItem>
    );
  }

  return (
    <MobileRadioItem value={value} icon={Icon} description={description} className={className}>
      {children}
    </MobileRadioItem>
  );
}

function MobileRadioItem({
  value,
  children,
  icon: Icon,
  description,
  className,
}: ResponsiveDropdownMenuRadioItemProps) {
  const { value: groupValue, onValueChange, closeOnSelect } = React.useContext(RadioGroupContext);
  const { close } = React.useContext(ResponsiveDropdownMenuContext);
  const isSelected = groupValue === value;

  return (
    <button
      role="radio"
      aria-checked={isSelected}
      className={cn(
        'flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors',
        'min-h-[44px] active:bg-accent/50',
        'last:border-b-0',
        className,
      )}
      onClick={() => {
        onValueChange?.(value);
        if (closeOnSelect) close();
      }}
    >
      {Icon && <Icon className="size-5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="text-[17px] leading-snug">{children}</div>
        {description && (
          <div className="text-[13px] leading-snug text-muted-foreground">{description}</div>
        )}
      </div>
      {isSelected && <Check className="size-5 shrink-0 text-primary" />}
    </button>
  );
}

export {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
};
