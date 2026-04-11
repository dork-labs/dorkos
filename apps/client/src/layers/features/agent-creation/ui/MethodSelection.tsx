import { FileText, Package, Search } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { CreationMode } from '../lib/wizard-types';

const METHODS = [
  {
    mode: 'new' as CreationMode,
    icon: FileText,
    iconBg: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    title: 'Start Blank',
    subtitle: 'Empty agent with a name and directory',
  },
  {
    mode: 'template' as CreationMode,
    icon: Package,
    iconBg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    title: 'From Template',
    subtitle: 'Pre-configured agent from the marketplace',
  },
  {
    mode: 'import' as CreationMode,
    icon: Search,
    iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    title: 'Import Project',
    subtitle: 'Scan for an existing project on disk',
  },
] as const;

/** Method selection cards rendered on the wizard's choose step. */
export function MethodSelection({ onSelect }: { onSelect: (mode: CreationMode) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
      {METHODS.map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.mode}
            type="button"
            onClick={() => onSelect(m.mode)}
            className={cn(
              'card-interactive flex items-center gap-3 rounded-xl border p-4 text-left',
              'sm:flex-col sm:text-center',
              'hover:border-border/80 transition-all duration-200 hover:shadow-md',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2'
            )}
            data-testid={`method-${m.mode}`}
          >
            <div
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-lg',
                m.iconBg
              )}
            >
              <Icon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{m.title}</p>
              <p className="text-muted-foreground text-[11px]">{m.subtitle}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
