import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { INHERIT, type TaskExecution } from './use-task-execution';

/** What {@link TaskExecutionFields} draws and writes back. */
export interface TaskExecutionFieldsProps {
  /** The task's runtime override; `''` means "follow the agent". */
  runtime: string;
  /** The task's model override; `''` means "agent default". */
  model: string;
  /** The task's effort override; `''` means "agent default". */
  effort: string;
  /** The resolved answer from `useTaskExecution`. */
  execution: TaskExecution;
  /** Write a new runtime override; `''` clears it. */
  onRuntimeChange: (value: string) => void;
  /** Write a new model override; `''` clears it. */
  onModelChange: (value: string) => void;
  /** Write a new effort override; `''` clears it. */
  onEffortChange: (value: string) => void;
}

/** The amber a setting that no longer holds is written in, app-wide. */
const WARNING_CLASS = 'text-xs text-amber-700 dark:text-amber-400';

/**
 * Which runtime a scheduled task runs on, on which model, thinking how hard.
 *
 * Three selects that all default to inheriting, because inheriting is what
 * every task did before these fields existed and is still the right answer for
 * almost all of them: the run follows its agent. Picking one is an override,
 * and picking the first option again clears it — there is no separate reset,
 * because a person who wants the default back looks for the default.
 *
 * Effort is the one control that can be absent rather than merely unset. A
 * runtime whose API has no effort setting (OpenCode) gets no control at all,
 * because a control whose every use is a no-op implies a decision a person does
 * not have. It comes back as a plain sentence — with a way to clear it — for the
 * one task that HAS an effort stored on such a runtime, since that is precisely
 * the value that has to be visible to be removed.
 *
 * @param props - See {@link TaskExecutionFieldsProps}.
 */
export function TaskExecutionFields({
  runtime,
  model,
  effort,
  execution,
  onRuntimeChange,
  onModelChange,
  onEffortChange,
}: TaskExecutionFieldsProps) {
  const {
    runtimeOptions,
    inheritRuntimeLabel,
    modelOptions,
    supportsEffort,
    effortOptions,
    runtimeWarning,
    modelWarning,
    effortWarning,
  } = execution;

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-sm font-medium">Runs on</legend>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-runtime">Runtime</Label>
        <Select
          value={runtime || INHERIT}
          onValueChange={(value) => onRuntimeChange(value === INHERIT ? '' : value)}
        >
          <SelectTrigger
            id="schedule-runtime"
            responsive={false}
            className="text-sm"
            data-testid="task-runtime-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{inheritRuntimeLabel}</SelectItem>
            {runtimeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {runtimeWarning && (
          <p data-testid="task-runtime-warning" className={WARNING_CLASS}>
            {runtimeWarning}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-model">Model</Label>
        <Select
          value={model || INHERIT}
          onValueChange={(value) => onModelChange(value === INHERIT ? '' : value)}
        >
          <SelectTrigger
            id="schedule-model"
            responsive={false}
            className="text-sm"
            data-testid="task-model-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Agent default</SelectItem>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {modelWarning && (
          <p data-testid="task-model-warning" className={WARNING_CLASS}>
            {modelWarning}
          </p>
        )}
      </div>

      {supportsEffort ? (
        <div className="space-y-1.5">
          <Label htmlFor="schedule-effort">Effort</Label>
          <Select
            value={effort || INHERIT}
            onValueChange={(value) => onEffortChange(value === INHERIT ? '' : value)}
          >
            <SelectTrigger
              id="schedule-effort"
              responsive={false}
              className="text-sm"
              data-testid="task-effort-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Agent default</SelectItem>
              {effortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {effortWarning && (
            <p data-testid="task-effort-warning" className={WARNING_CLASS}>
              {effortWarning}
            </p>
          )}
        </div>
      ) : (
        effort && (
          <div className="space-y-1.5" data-testid="task-effort-stranded">
            <Label>Effort</Label>
            <p className={WARNING_CLASS}>
              {effortWarning ?? 'This runtime has no effort setting, so this one does nothing.'}
            </p>
            <button
              type="button"
              onClick={() => onEffortChange('')}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              data-testid="task-effort-clear"
            >
              Clear it
            </button>
          </div>
        )
      )}
    </fieldset>
  );
}
