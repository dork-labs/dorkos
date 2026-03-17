import { cn } from '@/layers/shared/lib';

interface OptionRowProps {
  /** Whether this option is currently selected. */
  isSelected: boolean;
  /** Whether this option has keyboard focus (ring highlight). */
  isFocused?: boolean;
  /** Radio or checkbox control element. */
  control: React.ReactNode;
  /** Label and description content. */
  children: React.ReactNode;
  /** Data attribute for selection state. */
  'data-selected'?: boolean;
}

/** Shared row layout for question prompt options (radio and checkbox). */
export function OptionRow({
  isSelected,
  isFocused,
  control,
  children,
  'data-selected': dataSelected,
}: OptionRowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1 transition-all duration-150',
        isSelected ? 'bg-muted' : 'hover:bg-muted/80',
        isFocused && 'ring-1 ring-status-info/50',
      )}
      data-selected={dataSelected}
    >
      {control}
      {children}
    </div>
  );
}
