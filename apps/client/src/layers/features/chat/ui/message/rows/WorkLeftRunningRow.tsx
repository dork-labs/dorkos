import { useCallback, useState } from 'react';
import type { WorkLeftEndStatus, WorkLeftRunningPart } from '@dorkos/shared/types';
import { turnEnded } from '@dorkos/shared/schemas';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { workLeftLineId } from '@/layers/entities/session';

/** The longest a command is drawn before it is cut in the middle. */
const COMMAND_MAX_CHARS = 60;

/**
 * Cut a command in the middle, keeping its start and its end, which are the
 * two parts that say what it is.
 *
 * @param command - The shell command as the agent wrote it.
 * @param maxChars - The most characters to show.
 */
export function middleTruncate(command: string, maxChars = COMMAND_MAX_CHARS): string {
  if (command.length <= maxChars) return command;
  const keep = maxChars - 1;
  const head = Math.ceil(keep / 2);
  return `${command.slice(0, head)}…${command.slice(command.length - (keep - head))}`;
}

/** Props for {@link WorkLeftRunningRow}. */
interface WorkLeftRunningRowProps {
  /** The session the commands run in, for the per-task Stop. */
  sessionId: string;
  /** The line's part: each task, and how it ended once it has. */
  part: WorkLeftRunningPart;
}

/** What one Stop press came to, kept per task in this row. */
type StopState = 'stopping' | 'failed' | WorkLeftEndStatus;

/** One command, drawn as plain text: never markdown, never a link. */
function CommandText({ command }: { command: string }) {
  return (
    <code title={command} className="min-w-0 truncate font-mono text-xs">
      {middleTruncate(command) || 'A background command'}
    </code>
  );
}

/** The Stop for one command, or what pressing it came to. */
function StopControl({
  state,
  label,
  onStop,
}: {
  state: StopState | undefined;
  label: string;
  onStop: () => void;
}) {
  if (state === 'failed') {
    return (
      <span className="text-status-warning-fg text-xs" role="status">
        Couldn’t stop it, and it may keep running after DorkOS quits.
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="h-11 w-full shrink-0 sm:h-6 sm:w-auto"
      disabled={state === 'stopping'}
      onClick={onStop}
    >
      {label}
    </Button>
  );
}

/**
 * The lasting line under a stopped turn that names the background commands the
 * Stop could not end, each with its own Stop (DOR-3285).
 *
 * Amber while anything still runs; muted once everything has ended, from the
 * `ended` the server folds in after a reload or the live `work_left_ended` the
 * stream folds in, or from this row's own Stop. Live and on a reopened
 * conversation alike.
 */
export function WorkLeftRunningRow({ sessionId, part }: WorkLeftRunningRowProps) {
  const transport = useTransport();
  const [stops, setStops] = useState<Record<string, StopState>>({});
  const stop = useCallback(
    async (taskId: string) => {
      setStops((s) => ({ ...s, [taskId]: 'stopping' }));
      let next: StopState = 'failed';
      try {
        const { receipt } = await transport.stopTask(sessionId, taskId);
        if (turnEnded(receipt)) next = 'stopped';
      } catch {
        // `failed` already: the words below say what that means for the person.
      }
      setStops((s) => ({ ...s, [taskId]: next }));
    },
    [sessionId, transport]
  );
  const endedOf = (taskId: string, ended: WorkLeftEndStatus | undefined) => {
    const local = stops[taskId];
    return ended ?? (local === 'stopping' || local === 'failed' ? undefined : local);
  };
  const running = part.tasks.filter((task) => !endedOf(task.taskId, task.ended));
  const id = workLeftLineId(part);

  if (running.length === 0) {
    return (
      <div
        id={id}
        data-testid="work-left-running-row"
        className="text-muted-foreground py-1 text-xs"
      >
        Stopped. Everything has ended.
      </div>
    );
  }
  if (running.length === 1) {
    const task = running[0]!;
    return (
      <div
        id={id}
        data-testid="work-left-running-row"
        className="text-status-warning-fg py-1 text-xs"
      >
        <p>Stopped. 1 command is still running:</p>
        <div className="mt-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <CommandText command={task.command} />
          <StopControl
            state={stops[task.taskId]}
            label="Stop command"
            onStop={() => void stop(task.taskId)}
          />
        </div>
      </div>
    );
  }
  return (
    <div
      id={id}
      data-testid="work-left-running-row"
      className="text-status-warning-fg py-1 text-xs"
    >
      <p>Stopped. {running.length} commands are still running.</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {running.map((task) => (
          <li
            key={task.taskId}
            className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2"
          >
            <CommandText command={task.command} />
            <StopControl
              state={stops[task.taskId]}
              label="Stop"
              onStop={() => void stop(task.taskId)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
