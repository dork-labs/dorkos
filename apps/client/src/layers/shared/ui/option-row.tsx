import { cn } from '@/layers/shared/lib/utils';

/** Props for {@link OptionRow}. */
export interface OptionRowProps extends React.ComponentProps<'div'> {
  /** Whether this option is currently selected. */
  isSelected: boolean;
  /** Whether this option has keyboard focus (ring highlight). */
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
        'flex items-center gap-2 rounded px-2 py-1 transition-[background-color,box-shadow] duration-150',
        isSelected ? 'bg-muted' : 'hover:bg-muted/80',
        isFocused && 'ring-status-info/50 ring-1',
        className
      )}
      {...props}
      data-selected={isSelected}
    >
      {control}
      {children}
    </div>
  );
}
