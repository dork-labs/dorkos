import { motion } from 'motion/react';
import { Terminal, FileText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ShortcutChipsProps {
  onChipClick: (trigger: string) => void;
}

interface ChipDef {
  trigger: string;
  label: string;
  icon: LucideIcon;
  ariaLabel: string;
}

const chips: ChipDef[] = [
  { trigger: '/', label: 'Commands', icon: Terminal, ariaLabel: 'Insert slash command trigger' },
  { trigger: '@', label: 'Files', icon: FileText, ariaLabel: 'Insert file mention trigger' },
];

export function ShortcutChips({ onChipClick }: ShortcutChipsProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-center justify-center sm:justify-start gap-2 mt-1.5"
    >
      {chips.map((chip) => (
        <button
          key={chip.trigger}
          type="button"
          aria-label={chip.ariaLabel}
          onClick={() => onChipClick(chip.trigger)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150"
        >
          <chip.icon className="size-3" />
          <kbd className="font-mono text-[10px] opacity-60">{chip.trigger}</kbd>
          {chip.label}
        </button>
      ))}
    </motion.div>
  );
}
