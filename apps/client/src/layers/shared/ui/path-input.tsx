import * as React from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Button } from './button';
import { Input } from './input';

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
 *
 * The field inside is the app's own {@link Input} with its frame switched off,
 * not a copy of its recipe. The copy was missing the `selection:` colours and
 * the `text-base md:text-sm` guard that stops iOS zooming on focus — so the
 * path field quietly stopped matching every other field in the app each time
 * `Input` changed. The frame moved out here because it has to wrap the Browse
 * zone too; everything inside it stays in one file.
 *
 * `aria-invalid` styling is NOT one of the things this recipe restores: the
 * frame gives the field `border-0` and `focus-visible:ring-0`, which also
 * swallows `Input`'s `aria-invalid:border-destructive` and
 * `aria-invalid:ring-destructive/20`. No caller passes `aria-invalid` today,
 * so nothing is broken in practice — but the frame, not the field, is where
 * that treatment would have to be added if one ever does.
 */
function PathInput({
  className,
  disabled,
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
      <Input
        type="text"
        // The frame is the wrapper's job — the field keeps the recipe and gives
        // up the border, the background and its own focus ring, so the ring is
        // drawn once, around the field and the Browse button together.
        className="border-0 bg-transparent font-mono shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        disabled={disabled}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        {...props}
      />
      {onBrowse && (
        <>
          <div className="bg-border mx-0 h-5 w-px shrink-0" />
          <Button
            variant="ghost"
            size="sm"
            // Disabled with the field it belongs to: a dead path field beside a
            // live folder picker offers a way to change something you cannot.
            disabled={disabled}
            onClick={onBrowse}
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-l-none text-xs"
            aria-label={browseLabel}
            data-testid={browseTestId}
          >
            <FolderOpen className="size-3.5" />
            {browseLabel}
          </Button>
        </>
      )}
    </div>
  );
}

export { PathInput };
export type { PathInputProps };
