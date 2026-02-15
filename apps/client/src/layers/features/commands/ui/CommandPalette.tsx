import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import type { CommandEntry } from '@dorkos/shared/types';

interface CommandPaletteProps {
  filteredCommands: CommandEntry[];
  selectedIndex: number;
  onSelect: (cmd: CommandEntry) => void;
}

export function CommandPalette({ filteredCommands, selectedIndex, onSelect }: CommandPaletteProps) {
  // Pre-compute grouped structure with stable flat indices
  const groups = useMemo(() => {
    const result: { namespace: string; items: { cmd: CommandEntry; index: number }[] }[] = [];
    const grouped = new Map<string, { cmd: CommandEntry; index: number }[]>();
    let idx = 0;

    for (const cmd of filteredCommands) {
      if (!grouped.has(cmd.namespace)) {
        grouped.set(cmd.namespace, []);
      }
      grouped.get(cmd.namespace)!.push({ cmd, index: idx++ });
    }

    for (const [namespace, items] of grouped) {
      result.push({ namespace, items });
    }

    return result;
  }, [filteredCommands]);

  // Scroll active item into view when selection changes
  useEffect(() => {
    const activeEl = document.getElementById(`command-item-${selectedIndex}`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="bg-popover absolute right-0 bottom-full left-0 mb-2 max-h-80 overflow-hidden rounded-lg border shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div id="command-palette-listbox" role="listbox" className="max-h-72 overflow-y-auto p-2">
        {filteredCommands.length === 0 ? (
          <div className="text-muted-foreground px-2 py-4 text-center text-sm">
            No commands found.
          </div>
        ) : (
          groups.map(({ namespace, items }) => (
            <div key={namespace}>
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                {namespace}
              </div>
              {items.map(({ cmd, index }) => {
                const isSelected = index === selectedIndex;
                return (
                  <div
                    key={cmd.fullCommand}
                    id={`command-item-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => onSelect(cmd)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSelect(cmd);
                    }}
                    className="data-[selected=true]:bg-ring/10 data-[selected=true]:text-foreground hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 transition-colors duration-100"
                  >
                    <span className="font-mono text-sm">{cmd.fullCommand}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {cmd.description}
                    </span>
                    {cmd.argumentHint && (
                      <span className="text-muted-foreground/60 ml-auto text-xs">
                        {cmd.argumentHint}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
