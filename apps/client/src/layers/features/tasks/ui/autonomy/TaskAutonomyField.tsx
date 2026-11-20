/**
 * How much a schedule's runs may do on their own, on the schedule form's main
 * page (DOR-3841).
 *
 * It used to sit under "Advanced settings", which is shut at rest, so a new
 * schedule opened at Full autonomy (the Trusted default, ADR 261006-225605) and
 * nothing on screen said so. The level is now in plain view: the same Trust
 * Dial every other surface draws, captioned with the runtime's own `promise`
 * for the mode, never with copy written here.
 *
 * @module features/tasks/ui/autonomy/TaskAutonomyField
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { PermissionModeScopeNote, TrustDial } from '@/layers/shared/ui';
import { permissionModeLabel } from '@/layers/shared/lib';
import type { PermissionMode } from '@dorkos/shared/types';
import { asksWhileUnattended, TaskUnattendedWarning } from '../TaskUnattendedWarning';

/** Props for {@link TaskAutonomyField}. */
export interface TaskAutonomyFieldProps {
  /** The schedule's mode, as the form holds it. */
  mode: PermissionMode;
  /** The modes the runtime this schedule will run on declared; empty while unknown. */
  descriptors: readonly PermissionModeDescriptor[];
  /** Set the schedule's mode. */
  onChange: (mode: PermissionMode) => void;
  /** Read-only, for a schedule a package owns (DOR-2272). */
  disabled?: boolean;
}

/**
 * The Permissions control: the Trust Dial, what the picked level allows, and
 * the warning a scheduled run needs when its stop would ask.
 *
 * @param props - The current mode, the runtime's declared modes, and the change handler.
 */
export function TaskAutonomyField({
  mode,
  descriptors,
  onChange,
  disabled,
}: TaskAutonomyFieldProps) {
  const current = descriptors.find((d) => d.id === mode);
  // The runtime's own word for the mode wherever it declared one.
  const modeLabel = current?.label ?? permissionModeLabel(mode);
  if (descriptors.length === 0) {
    // No profile in hand: one round trip on a cold open, and forever under a
    // test-mode boot, where the scheduler runs on `TestModeRuntime` and
    // `claude-code` is never registered.
    return (
      <fieldset disabled={disabled} className="min-w-0 space-y-2">
        <legend className="mb-1.5 text-sm font-medium">Permissions</legend>
        <p
          data-testid="trust-dial-unavailable"
          className="text-muted-foreground px-1 text-xs leading-relaxed"
        >
          Set to “{modeLabel}”. No other options to choose yet. Saving keeps it.
        </p>
      </fieldset>
    );
  }
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2" data-testid="task-autonomy-field">
      <legend className="mb-1.5 text-sm font-medium">Permissions</legend>
      <TrustDial
        mode={mode}
        descriptors={descriptors}
        onChangeMode={(next) => onChange(next as PermissionMode)}
        // A schedule has no Plan switch. One saved at `plan` is kept and named,
        // not frozen behind a control that is not on this screen.
        strandsWorkingMode
        strandedNote={
          <>Set to “{modeLabel}”, which isn’t listed. Saving keeps it. Pick a stop to change it.</>
        }
      />
      {/* The fact that is true here and on no attended surface: a stop that
          asks has nobody to ask, so the ask is refused the moment it is raised
          and the run needs attention (DOR-3123 A1). Read from what the runtime
          declared, never from a guess about the prompt. */}
      {current !== undefined && asksWhileUnattended(current) && <TaskUnattendedWarning />}
      <PermissionModeScopeNote
        mode={mode}
        {...(current ? { descriptor: current } : {})}
        className="px-1"
      />
    </fieldset>
  );
}
