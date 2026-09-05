import { cn } from '@/layers/shared/lib/utils';

/** Styled keyboard shortcut indicator, hidden on mobile. */
function Kbd({ className, children, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground text-3xs pointer-events-none hidden h-5 items-center gap-1 rounded border px-1.5 font-mono font-medium select-none md:inline-flex',
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

export { Kbd };
