import { useId } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { Task } from '@dorkos/shared/types';
import { PermissionModeScopeNote } from '@/layers/shared/ui';

/** The run's mode and the separately approved folder rules, before the person approves. */
export function SchedulePermissionChoice({
  task,
  modes,
  value,
  requested,
  onChange,
}: {
  task: Task;
  modes: readonly PermissionModeDescriptor[];
  value: string;
  requested: PermissionModeDescriptor | null;
  onChange: (mode: string) => void;
}) {
  const id = useId();
  const selected = modes.find((mode) => mode.id === value);
  const rules = task.folderRules;
  return (
    <div className="min-w-0 space-y-2 text-xs" data-slot="schedule-mode-choice">
      <label htmlFor={id} className="block font-medium">
        Run permissions
      </label>
      <select
        id={id}
        value={value}
        aria-describedby={selected ? `${id}-promise` : undefined}
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
      {requested && <p data-slot="schedule-requested-mode">Reason asks for {requested.label}.</p>}
      {requested && value !== requested.id && (
        <p role="status" data-slot="schedule-mode-mismatch" className="text-status-warning-fg">
          Selected permissions differ from the reason’s request.
        </p>
      )}
      {selected && (
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
