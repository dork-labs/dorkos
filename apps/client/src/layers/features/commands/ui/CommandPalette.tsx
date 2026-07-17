import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import type { CommandEntry } from '@dorkos/shared/types';
import type { RankedCommandEntry } from '@/layers/entities/command';

interface CommandPaletteProps {
  filteredCommands: RankedCommandEntry[];
  selectedIndex: number;
  onSelect: (cmd: CommandEntry) => void;
}

/** Dropdown list of available commands grouped by namespace. */
export function CommandPalette({ filteredCommands, selectedIndex, onSelect }: CommandPaletteProps) {
  // Pre-compute grouped structure with stable flat indices
  const groups = useMemo(() => {
    const result: { namespace: string; items: { cmd: RankedCommandEntry; index: number }[] }[] = [];
    const grouped = new Map<string, { cmd: RankedCommandEntry; index: number }[]>();
    let idx = 0;

    for (const cmd of filteredCommands) {
      const ns = cmd.namespace ?? 'built-in';
      if (!grouped.has(ns)) {
        grouped.set(ns, []);
      }
      grouped.get(ns)!.push({ cmd, index: idx++ });
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
      className="bg-popover max-h-80 overflow-hidden rounded-lg border shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div id="command-palette-listbox" role="listbox" className="max-h-72 overflow-y-auto p-1.5">
        {filteredCommands.length === 0 ? (
          <div className="text-muted-foreground px-2 py-4 text-center text-sm">
            No commands found.
          </div>
        ) : (
          groups.map(({ namespace, items }, groupIdx) => (
            <div key={namespace}>
              {groupIdx > 0 && <div className="bg-border mx-2 my-1.5 h-px" />}
              <div className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide uppercase">
                {namespace}
              </div>
              {items.map(({ cmd, index }) => {
                const isSelected = index === selectedIndex;
                // Honest capability gating (DOR-109): a runtime-fulfilled intent
                // the active runtime cannot fulfill renders greyed-out and is not
                // selectable by click or keyboard.
                const isDisabled = cmd.disabled === true;
                return (
                  <div
                    key={cmd.fullCommand}
                    id={`command-item-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isDisabled}
                    data-selected={isSelected}
                    data-disabled={isDisabled}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => {
                      if (!isDisabled) onSelect(cmd);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isDisabled) onSelect(cmd);
                    }}
                    className={
                      isDisabled
                        ? 'cursor-not-allowed rounded-md px-2 py-1.5 opacity-45'
                        : 'data-[selected=true]:bg-accent hover:bg-muted cursor-pointer rounded-md px-2 py-1.5 transition-colors duration-100'
                    }
                  >
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="text-foreground shrink-0 font-mono text-[13px] font-medium">
                        {cmd.fullCommand}
                      </span>
                      {cmd.argumentHint && (
                        <span className="text-muted-foreground/50 shrink-0 font-mono text-xs">
                          {cmd.argumentHint}
                        </span>
                      )}
                      {isDisabled && cmd.disabledReason ? (
                        <span className="text-muted-foreground/70 ml-auto shrink-0 text-[11px]">
                          {cmd.disabledReason}
                        </span>
                      ) : (
                        cmd.matchedAlias && (
                          <span className="text-muted-foreground/60 ml-auto shrink-0 font-mono text-[11px] italic">
                            matched /{cmd.matchedAlias.replace(/^\//, '')}
                          </span>
                        )
                      )}
                    </div>
                    {cmd.description && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs leading-normal">
                        {cmd.description}
                      </p>
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
