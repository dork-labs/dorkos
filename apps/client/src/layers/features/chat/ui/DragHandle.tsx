interface DragHandleProps {
  collapsed: boolean;
  onToggle: () => void;
}

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
      className="flex items-center justify-center h-6 w-full cursor-pointer"
    >
      <div className="w-9 h-1 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50 active:bg-muted-foreground/50 transition-colors" />
    </div>
  );
}
