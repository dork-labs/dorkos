import { Check, Copy } from 'lucide-react';
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
 * Icon button that copies a string to the clipboard with timed check-mark feedback.
 *
 * Uses {@link useCopyFeedback} to manage the success state. Defaults match the
 * compact form used inside Settings dialogs (size-3.5 icon, muted-foreground hover).
 */
export function CopyButton({
  value,
  label = 'Copy to clipboard',
  className,
  size = 'sm',
}: CopyButtonProps) {
  const [copied, copy] = useCopyFeedback();
  const iconSize = size === 'md' ? 'size-4' : 'size-3.5';
  return (
    <button
      className={cn(
        'text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors',
        className
      )}
      onClick={() => copy(value)}
      aria-label={label}
    >
      {copied ? (
        <Check className={cn(iconSize, 'text-green-500')} />
      ) : (
        <Copy className={iconSize} />
      )}
    </button>
  );
}
