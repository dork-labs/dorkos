import { Check, Copy, X } from 'lucide-react';
import { cn, useCopyFeedback } from '@/layers/shared/lib';

interface CopyButtonProps {
  /** Text copied to clipboard on click. */
  value: string;
  /** Optional aria-label override. Default: "Copy to clipboard". */
  label?: string;
  /** Override className for the button wrapper. */
  className?: string;
  /** Icon size — defaults to size-3.5 to match current usage. */
  size?: 'sm' | 'md';
}

/**
 * Icon button that copies a string to the clipboard with timed inline feedback.
 *
 * Uses {@link useCopyFeedback} to manage the success/failure state. Defaults
 * match the compact form used inside Settings dialogs (size-3.5 icon,
 * muted-foreground hover).
 */
export function CopyButton({
  value,
  label = 'Copy to clipboard',
  className,
  size = 'sm',
}: CopyButtonProps) {
  const { copied, failed, copy } = useCopyFeedback();
  const iconSize = size === 'md' ? 'size-4' : 'size-3.5';
  return (
    <button
      className={cn(
        // `focus-ring` is opt-in: index.css clears the native outline globally,
        // so a bare button is invisible to keyboard focus without it.
        'text-muted-foreground hover:text-foreground focus-ring rounded-sm p-1 transition-colors',
        className
      )}
      onClick={() => void copy(value)}
      aria-label={failed ? "Couldn't copy — try again" : label}
    >
      {copied ? (
        <Check className={cn(iconSize, 'text-green-500')} />
      ) : failed ? (
        <X className={cn(iconSize, 'text-destructive')} />
      ) : (
        <Copy className={iconSize} />
      )}
    </button>
  );
}
