import { useId } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { Task } from '@dorkos/shared/types';
import { Button, PermissionModeScopeNote } from '@/layers/shared/ui';
import { isNoLooserThan } from '@dorkos/shared/permission-semantics';

/** The run's mode and the separately approved folder rules, before the person approves. */
export function SchedulePermissionChoice({
  task,
  modes,
  value,
  requested,
  onChange,
  onUseRequested,
}: {
  task: Task;
  modes: readonly PermissionModeDescriptor[];
  value: string;
  requested: PermissionModeDescriptor | null;
  onChange: (mode: string) => void;
  onUseRequested?: () => void;
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
        aria-describedby={selected ? `${id}-${looser ? 'mismatch' : 'promise'}` : undefined}
        onChange={(event) => onChange(event.target.value)}
        disabled={modes.length === 0}
        className="focus-ring border-input bg-background min-h-11 w-full rounded-md border px-2 disabled:opacity-50"
      >
        {!selected && <option value={value}>Saved mode (unavailable)</option>}
        {modes.map((mode) => (
          <option key={mode.id} value={mode.id}>
            {mode.label}
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
          {task.proposedByName ?? 'An agent'} asked for {requested.label}. This will run at{' '}
          {selected.label}.{looser && ` ${selected.promise}`}
        </p>
      )}
      {mismatch && onUseRequested && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 w-full text-xs sm:w-auto"
          onClick={onUseRequested}
        >
          Use {requested.label}
        </Button>
      )}
      {selected && !looser && (
        <p id={`${id}-promise`} className="text-muted-foreground">
          {selected.promise}
        </p>
      )}
      {selected && <PermissionModeScopeNote mode={value} descriptor={selected} />}
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
            Unapproved commands are refused. Nobody is asked during a scheduled run.
          </p>
        )}
      </div>
    </div>
  );
}
