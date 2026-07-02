import { getRuntimeDescriptor, useRuntimeCapabilities } from '@/layers/entities/runtime';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';

interface RuntimeItemProps {
  /**
   * Runtime type to display. The render site owns resolution: the session
   * row's server-authoritative `runtime` once the session has started, the
   * pending `?runtime=` selection or server default before that. Deliberately
   * NOT resolved here via `useActiveCapabilities` — the runtime-type endpoint
   * infers-on-miss (never 404s) and that query caches with
   * `staleTime: Infinity`, so a pre-bind fetch could pin the wrong identity.
   */
  runtime: string;
  /** Called with the chosen runtime type when the user picks one pre-launch. */
  onChangeRuntime?: (type: string) => void;
  /**
   * Whether the runtime can still be chosen. False once the session has
   * started — runtime is immutable for a session's lifetime (ADR-0255).
   */
  canSelect: boolean;
}

/**
 * Status bar chip showing the session's agent runtime.
 *
 * Selectable only in the pre-first-message state and only when more than one
 * runtime is registered (the list comes from `useRuntimeCapabilities()`, so
 * unregistered runtimes never appear). Once a session has started the chip is
 * read-only with a tooltip explaining the immutability; with a single
 * registered runtime it is a quiet identity chip with no dropdown affordance.
 */
export function RuntimeItem({ runtime, onChangeRuntime, canSelect }: RuntimeItemProps) {
  const { data: capabilityMap } = useRuntimeCapabilities();

  const descriptor = getRuntimeDescriptor(runtime);
  const Icon = descriptor.icon;

  const registeredTypes = Object.keys(capabilityMap?.capabilities ?? {});
  const selectable = canSelect && !!onChangeRuntime && registeredTypes.length > 1;

  // Read-only identity chip. Deliberately not dimmed: unlike a temporarily
  // disabled control, "this session runs on Claude Code" is the chip's steady
  // state, so it renders at full strength like the other info items.
  const chip = (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-(--size-icon-xs)" />
      <span>{descriptor.label}</span>
    </span>
  );

  if (!canSelect) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">Runtime is fixed once a session starts</TooltipContent>
      </Tooltip>
    );
  }

  // Pre-launch but nothing to choose (single runtime, or list still loading):
  // no dropdown affordance — with one runtime DorkOS looks as it does today.
  if (!selectable) {
    return chip;
  }

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150">
          <Icon className="size-(--size-icon-xs)" />
          <span>{descriptor.label}</span>
        </button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        <ResponsiveDropdownMenuLabel>Runtime</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup
          value={runtime}
          onValueChange={(v) => onChangeRuntime?.(v)}
        >
          {registeredTypes.map((type) => {
            const d = getRuntimeDescriptor(type);
            return (
              <ResponsiveDropdownMenuRadioItem key={type} value={type} icon={d.icon}>
                {d.label}
              </ResponsiveDropdownMenuRadioItem>
            );
          })}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
