import * as React from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';

interface PathInputProps extends Omit<React.ComponentProps<'input'>, 'type' | 'onChange'> {
  /** Called when the text value changes. */
  onChange?: (value: string) => void;
  /** Called when the Browse button is clicked. */
  onBrowse?: () => void;
  /** Label for the browse button. @default "Browse" */
  browseLabel?: string;
  /** Test ID for the browse button. */
  browseTestId?: string;
}

/**
 * Integrated path input with a Browse action zone.
 *
 * Renders a single container: an editable path field on the left and a
 * "Browse" button separated by a subtle divider on the right. Follows
 * the GitHub Desktop / Warp "integrated field" pattern (Tier 2).
 */
function PathInput({
  className,
  onChange,
  onBrowse,
  browseLabel = 'Browse',
  browseTestId,
  ...props
}: PathInputProps) {
  return (
    <div
      data-slot="path-input"
      className={cn(
        'dark:bg-input/30 border-input flex items-center rounded-md border bg-transparent shadow-xs transition-[color,box-shadow]',
        'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
        className
      )}
    >
      <input
        type="text"
        className={cn(
          'placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent px-3 py-1 font-mono text-sm outline-none md:h-9',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'
        )}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        {...props}
      />
      {onBrowse && (
        <>
          <div className="bg-border mx-0 h-5 w-px shrink-0" />
          <button
            type="button"
            onClick={onBrowse}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex shrink-0 items-center gap-1.5 rounded-r-md px-3 py-2 text-xs font-medium transition-colors"
            aria-label={browseLabel}
            data-testid={browseTestId}
          >
            <FolderOpen className="size-3.5" />
            {browseLabel}
          </button>
        </>
      )}
    </div>
  );
}

export { PathInput };
export type { PathInputProps };
