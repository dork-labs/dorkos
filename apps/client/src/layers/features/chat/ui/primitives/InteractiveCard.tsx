import { cn } from '@/layers/shared/lib';

interface InteractiveCardProps {
  /** Whether this card is the active keyboard shortcut target — shows focus ring. */
  isActive?: boolean;
  /** Whether the user has already acted (approved/denied/submitted) — prevents opacity dim. */
  isResolved?: boolean;
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  [key: `data-${string}`]: string | undefined;
}

/** Styled container for chat-stream elements that block agent progress until the user acts. */
export function InteractiveCard({
  isActive = false,
  isResolved = false,
  children,
  className,
  ...dataProps
}: InteractiveCardProps) {
  return (
    <div
      className={cn(
        'border-status-info bg-muted/50 rounded-msg-tool border-l-2 p-3 text-sm transition-all duration-200',
        isActive && 'ring-ring/30 ring-2',
        !isActive && !isResolved && 'opacity-60',
        className
      )}
      {...dataProps}
    >
      {children}
    </div>
  );
}
