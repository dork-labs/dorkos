import { useId } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { Task } from '@dorkos/shared/types';
import { Button, Checkbox, PermissionModeScopeNote } from '@/layers/shared/ui';
import { actsWithoutAsking, isNoLooserThan } from '@dorkos/shared/permission-semantics';
import {
  readsBroadly,
  runsPrograms,
  writesOutsideTaskFolder,
} from '@dorkos/shared/permission-rules';
import {
  scheduleConfirmLabel,
  schedulePermissionLabel,
  type ScheduleConfirmReason,
} from '../lib/schedule-permission-copy';

/** The run's mode and the separately approved folder rules, before the person approves. */
export function SchedulePermissionChoice({
  task,
  modes,
  value,
  requested,
  onChange,
  onUseRequested,
  confirmLooser,
  onConfirmLooserChange,
  confirmReason,
}: {
  task: Task;
  modes: readonly PermissionModeDescriptor[];
  value: string;
  requested: PermissionModeDescriptor | null;
  onChange: (mode: string) => void;
  onUseRequested?: () => void;
  confirmLooser: boolean;
  onConfirmLooserChange: (confirmed: boolean) => void;
  /** Why approving needs the separate tick, or `null` when it does not. */
  confirmReason: ScheduleConfirmReason | null;
}) {
  const id = useId();
  const selected = modes.find((mode) => mode.id === value);
  const mismatch = requested && selected && value !== requested.id;
  const looser = mismatch && !isNoLooserThan(requested, selected);
  const rules = task.folderRules;
  return (
    <div className="min-w-0 space-y-2 text-xs" data-slot="schedule-mode-choice">
      <label htmlFor={id} className="block font-medium">
        Run permissions
      </label>
      <select
        id={id}
        value={value}
        aria-describedby={looser ? `${id}-mismatch` : undefined}
        onChange={(event) => onChange(event.target.value)}
        disabled={modes.length === 0}
        className="focus-ring border-input bg-background min-h-11 w-full rounded-md border px-2 disabled:opacity-50"
      >
        {!selected && <option value={value}>Saved mode (unavailable)</option>}
        {modes.map((mode) => (
          <option key={mode.id} value={mode.id}>
            {schedulePermissionLabel(mode.id, mode.label)}
          </option>
        ))}
      </select>
      {mismatch && (
        <p
          id={`${id}-mismatch`}
          role="status"
          data-slot="schedule-mode-mismatch"
          className="text-status-warning-fg"
        >
          {task.proposedByName ?? 'An agent'} proposed{' '}
          {schedulePermissionLabel(requested.id, requested.label)}. Selected:{' '}
          {schedulePermissionLabel(selected.id, selected.label)}.
        </p>
      )}
      {mismatch && onUseRequested && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 w-full text-xs sm:w-auto"
          onClick={onUseRequested}
        >
          Use {schedulePermissionLabel(requested.id, requested.label)}
        </Button>
      )}
      {task.requestedAllow && task.requestedAllow.length > 0 && (
        <div data-slot="schedule-requested-allow" className="space-y-1">
          {/* Only Allowed commands limits a run to its rules; every other mode
              keeps what it already allows and adds these on top. */}
          <p className="font-medium">
            {value === 'dontAsk'
              ? 'Runs without asking, and may only:'
              : 'Also runs these without asking:'}
          </p>
          <ul className="space-y-1">
            {task.requestedAllow.map((rule) => (
              <li key={rule} className="font-mono break-all">
                {rule}
              </li>
            ))}
          </ul>
          {task.requestedAllow.some(runsPrograms) && (
            <p data-slot="schedule-runs-programs" className="text-status-warning-fg">
              Can run programs on this computer.
            </p>
          )}
          {task.requestedAllow.some(readsBroadly) && (
            <p data-slot="schedule-reads-broadly" className="text-status-warning-fg">
              Can read files across this computer.
            </p>
          )}
          {task.requestedAllow.some(writesOutsideTaskFolder) && (
            <p data-slot="schedule-writes-outside" className="text-status-warning-fg">
              Can change files outside its folder.
            </p>
          )}
        </div>
      )}
      {/* After what it confirms, so the tick answers what was just read. It
          looks 24px tall; on a touch screen an invisible layer reaches 10px
          above and below, so the whole row is a 44px target and nothing moves. */}
      {confirmReason && (
        <label className="relative flex min-h-6 items-center gap-2 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']">
          <Checkbox
            checked={confirmLooser}
            onCheckedChange={(checked) => onConfirmLooserChange(checked === true)}
          />
          <span>
            {scheduleConfirmLabel(
              confirmReason,
              selected ? schedulePermissionLabel(selected.id, selected.label) : undefined
            )}
          </span>
        </label>
      )}
      {/* What a never-asks mode still does not cover: DorkOS's own actions. */}
      {selected && actsWithoutAsking(selected) && (
        <PermissionModeScopeNote mode={value} descriptor={selected} />
      )}
      <div data-slot="schedule-folder-rules" className="space-y-1">
        <p className="font-medium">Approved folder rules</p>
        {rules?.status === 'approved' && rules.applied.length > 0 ? (
          <>
            <ul className="space-y-1">
              {rules.applied.map((rule) => (
                <li key={rule} className="font-mono break-all">
                  {rule}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Other permission limits still apply. Rules are checked again when the run starts.
            </p>
          </>
        ) : rules?.status === 'waiting' ? (
          <>
            <p className="text-status-warning-fg">These commands still need a person.</p>
            <ul className="space-y-1">
              {rules.pending.map((rule) => (
                <li key={rule} className="font-mono break-all">
                  {rule}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Approving this schedule doesn’t approve these rules.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            {rules?.status === 'none'
              ? 'No approved folder rules apply.'
              : 'Folder rules couldn’t be checked. Check them before approving.'}
          </p>
        )}
        {value === 'dontAsk' && (
          <p className="text-muted-foreground">
            Unapproved commands are refused during scheduled runs.
          </p>
        )}
      </div>
    </div>
  );
}
