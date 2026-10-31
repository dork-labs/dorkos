import { cn } from '@/layers/shared/lib/utils';
import { rowTintVariants } from './row';

/** Props for {@link OptionRow}. */
export interface OptionRowProps extends React.ComponentProps<'div'> {
  /** Whether this option is currently selected. */
  isSelected: boolean;
  /** Whether this option has keyboard focus (the inset row outline). */
  isFocused?: boolean;
  /** Radio or checkbox control element. */
  control: React.ReactNode;
  /** Label and description content. */
  children: React.ReactNode;
}

/**
 * Shared row layout for question prompt options (radio and checkbox).
 *
 * `data-selected` is stamped from `isSelected` rather than taken as a second
 * prop — the two were the same fact asked for twice, and a caller could set one
 * without the other.
 */
export function OptionRow({
  isSelected,
  isFocused,
  control,
  children,
  className,
  ...props
}: OptionRowProps) {
  return (
    <div
      data-slot="option-row"
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1 transition-[background-color] duration-150',
        rowTintVariants({ state: isSelected ? 'selected' : 'rest' }),
        // The prompt's own roving focus, not the browser's: the same inset
        // outline a focus-visible row draws, with the hover tint beside it.
        isFocused && 'outline-ring outline-2 -outline-offset-2',
        isFocused && !isSelected && 'bg-row-hover',
        className
      )}
      {...props}
      data-selected={isSelected}
      data-focused={isFocused || undefined}
      data-row-state={isSelected ? 'selected' : 'rest'}
    >
      {control}
      {children}
    </div>
  );
}
