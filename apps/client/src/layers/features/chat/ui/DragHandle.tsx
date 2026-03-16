interface DragHandleProps {
  collapsed: boolean;
  onToggle: () => void;
}

/** Pill-shaped toggle bar for collapsing or expanding an adjacent panel section. */
export function DragHandle({ collapsed, onToggle }: DragHandleProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={collapsed ? 'Expand input extras' : 'Collapse input extras'}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      className="flex h-6 w-full cursor-pointer items-center justify-center"
    >
      <div className="bg-muted-foreground/30 hover:bg-muted-foreground/50 active:bg-muted-foreground/50 h-1 w-9 rounded-full transition-colors" />
    </div>
  );
}
