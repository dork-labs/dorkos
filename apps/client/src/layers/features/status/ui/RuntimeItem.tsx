import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  RUNTIME_DESCRIPTORS,
  RuntimeIdentity,
  RuntimeSetupDialog,
  getRuntimeDescriptor,
  isRuntimeReady,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';

interface RuntimeItemProps {
  /**
   * Runtime type to display. The render site owns resolution: the session
   * row's server-authoritative `runtime` once the session has started, the
   * pending `?runtime=` selection or server default before that. Deliberately
   * NOT resolved here from a session id — the runtime-type endpoint
   * infers-on-miss (never 404s), so a forever-cached pre-bind fetch could pin
   * the wrong identity.
   */
  runtime: string;
  /**
   * The started session's resolved model id, paired with `runtime` to show
   * identity as runtime + model (spec decision 8). Nullish — pre-launch or a
   * runtime with no reported model — degrades the chip to the runtime alone.
   */
  model?: string | null;
  /** Called with the chosen runtime type when the user picks one pre-launch. */
  onChangeRuntime?: (type: string) => void;
  /**
   * Whether the runtime can still be chosen. False once the session has
   * started — runtime is immutable for a session's lifetime (ADR-0255).
   */
  canSelect: boolean;
}

/** Setup-dialog state: closed, scoped to one runtime, or the unscoped overview. */
type SetupDialogState = { open: boolean; runtime?: string };

/**
 * Status bar chip showing the session's agent runtime.
 *
 * Selectable only in the pre-first-message state. Once a session has started
 * the chip is read-only with a tooltip explaining the immutability.
 *
 * Pre-launch, the dropdown renders whenever it has something actionable:
 * another registered runtime to pick, a registered runtime that needs setup,
 * or a known runtime this server has not registered (the "Add a runtime"
 * entry). This keeps "Add a runtime" reachable on single-runtime installs —
 * the chip at the moment of choosing where a session runs is the one place a
 * user discovers that DorkOS speaks more than one runtime (spec
 * additional-agent-runtimes, 4.2). Only when nothing is actionable (or the
 * capability map is still loading) does it stay a quiet identity chip.
 *
 * Runtimes that are not ready are never dead options: they render as a single
 * "Connect" entry that opens the Ready/Connect setup surface (one-click
 * provisioning for OpenCode; the terminal detail lives behind Advanced).
 */
export function RuntimeItem({ runtime, model, onChangeRuntime, canSelect }: RuntimeItemProps) {
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: requirements } = useRuntimeRequirements();
  const [setupDialog, setSetupDialog] = useState<SetupDialogState>({ open: false });

  const registeredTypes = Object.keys(capabilityMap?.capabilities ?? {});
  // Ready runtimes are selectable; unsatisfied ones get the setup affordance.
  // While requirements load, isRuntimeReady is optimistically true — the
  // picker never flashes a needs-setup state it cannot substantiate.
  const readyTypes = registeredTypes.filter((t) => isRuntimeReady(requirements, t));
  const needsSetupTypes = registeredTypes.filter((t) => !isRuntimeReady(requirements, t));
  // Known runtimes with published setup steps that this server has not
  // registered — the "Add a runtime" entry point.
  const hasAddableRuntime =
    capabilityMap !== undefined &&
    Object.values(RUNTIME_DESCRIPTORS).some((d) => d.setup && !registeredTypes.includes(d.type));

  // Actionable content gates the dropdown: another runtime to select, a
  // registered runtime needing setup, or an addable runtime to discover.
  const selectable =
    canSelect &&
    !!onChangeRuntime &&
    (registeredTypes.length > 1 || needsSetupTypes.length > 0 || hasAddableRuntime);

  // Read-only identity chip. Deliberately not dimmed: unlike a temporarily
  // disabled control, "this session runs on OpenCode · qwen2.5-coder" is the
  // chip's steady state, so it renders at full strength like the other info
  // items. Identity is runtime + model via the shared RuntimeIdentity.
  const chip = (
    <RuntimeIdentity runtime={runtime} model={model} iconClassName="size-(--size-icon-xs)" />
  );

  if (!canSelect) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">Runtime is fixed once a session starts</TooltipContent>
      </Tooltip>
    );
  }

  // Pre-launch but nothing actionable (every known runtime registered and
  // ready with no alternative to pick, or the list is still loading): quiet
  // identity chip, no dropdown affordance.
  if (!selectable) {
    return chip;
  }

  return (
    <>
      <ResponsiveDropdownMenu>
        <ResponsiveDropdownMenuTrigger asChild>
          <button className="hover:text-foreground transition-colors duration-150">
            <RuntimeIdentity
              runtime={runtime}
              model={model}
              iconClassName="size-(--size-icon-xs)"
            />
          </button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
          <ResponsiveDropdownMenuLabel>Runtime</ResponsiveDropdownMenuLabel>
          <ResponsiveDropdownMenuRadioGroup
            value={runtime}
            onValueChange={(v) => onChangeRuntime?.(v)}
          >
            {readyTypes.map((type) => {
              const d = getRuntimeDescriptor(type);
              return (
                <ResponsiveDropdownMenuRadioItem key={type} value={type} icon={d.icon}>
                  {d.label}
                </ResponsiveDropdownMenuRadioItem>
              );
            })}
          </ResponsiveDropdownMenuRadioGroup>
          {needsSetupTypes.map((type) => {
            const d = getRuntimeDescriptor(type);
            return (
              <ResponsiveDropdownMenuItem
                key={type}
                icon={d.icon}
                description="Connect"
                onSelect={() => setSetupDialog({ open: true, runtime: type })}
              >
                {d.label}
              </ResponsiveDropdownMenuItem>
            );
          })}
          {hasAddableRuntime && (
            <>
              <ResponsiveDropdownMenuSeparator />
              <ResponsiveDropdownMenuItem
                icon={Plus}
                onSelect={() => setSetupDialog({ open: true })}
              >
                Add a runtime
              </ResponsiveDropdownMenuItem>
            </>
          )}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
      <RuntimeSetupDialog
        runtime={setupDialog.runtime}
        open={setupDialog.open}
        onOpenChange={(open) => setSetupDialog((s) => ({ ...s, open }))}
        renderConnect={renderRuntimeConnect}
      />
    </>
  );
}
