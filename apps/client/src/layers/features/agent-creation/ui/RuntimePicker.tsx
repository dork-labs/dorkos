import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';
import { PRIMARY_RUNTIME_TYPES, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn } from '@/layers/shared/lib';

/** Props for {@link RuntimePicker}. */
export interface RuntimePickerProps {
  /** The selected runtime. */
  value: AgentRuntime;
  /** Called with the picked runtime. */
  onChange: (runtime: AgentRuntime) => void;
}

/**
 * A compact segmented picker over the three product runtimes (Claude Code,
 * Codex, OpenCode). Each option shows the runtime's own icon and label from the
 * shared descriptor registry, so it reads identically to every other runtime
 * surface.
 *
 * @param props - Selected runtime and change handler.
 */
export function RuntimePicker({ value, onChange }: RuntimePickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Runtime"
      className="flex gap-1.5"
      data-testid="runtime-picker"
    >
      {PRIMARY_RUNTIME_TYPES.map((type) => {
        const descriptor = getRuntimeDescriptor(type);
        const Icon = descriptor.icon;
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(type)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              selected
                ? 'border-primary bg-primary/10 font-medium'
                : 'hover:border-border hover:bg-accent border-transparent'
            )}
            data-testid={`runtime-${type}`}
          >
            <Icon size={14} />
            {descriptor.label}
          </button>
        );
      })}
    </div>
  );
}
