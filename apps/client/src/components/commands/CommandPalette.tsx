import { useEffect } from 'react';
import { motion } from 'motion/react';
import type { CommandEntry } from '@lifeos/shared/types';

interface CommandPaletteProps {
  filteredCommands: CommandEntry[];
  selectedIndex: number;
  onSelect: (cmd: CommandEntry) => void;
  onClose: () => void;
}

export function CommandPalette({ filteredCommands, selectedIndex, onSelect, onClose }: CommandPaletteProps) {
  void onClose;

  // Group by namespace
  const grouped = filteredCommands.reduce<Record<string, CommandEntry[]>>(
    (acc, cmd) => {
      (acc[cmd.namespace] ??= []).push(cmd);
      return acc;
    },
    {}
  );

  // Scroll active item into view when selection changes
  useEffect(() => {
    const activeEl = document.getElementById(`command-item-${selectedIndex}`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Track flat index across groups for selectedIndex mapping
  let flatIndex = 0;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        id="command-palette-listbox"
        role="listbox"
        className="max-h-72 overflow-y-auto p-2"
      >
        {filteredCommands.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No commands found.
          </div>
        ) : (
          Object.entries(grouped).map(([namespace, cmds]) => (
            <div key={namespace}>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {namespace}
              </div>
              {cmds.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;
                return (
                  <div
                    key={cmd.fullCommand}
                    id={`command-item-${currentIndex}`}
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    onClick={() => onSelect(cmd)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors duration-100 data-[selected=true]:bg-ring/10 data-[selected=true]:text-foreground hover:bg-muted"
                  >
                    <span className="font-mono text-sm">
                      {cmd.fullCommand}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {cmd.description}
                    </span>
                    {cmd.argumentHint && (
                      <span className="text-xs text-muted-foreground/60 ml-auto">
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
