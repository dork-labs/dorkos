import type { Task } from '@dorkos/shared/types';
import { revealHiddenCharacters } from '@dorkos/shared/marketplace-schemas';
import { listRefusedTools, readableToolName } from '@dorkos/shared/run-refusals';
import { useApproveTaskFile } from '@/layers/entities/tasks';
import { usePermissionModeLabel } from '@/layers/entities/runtime';
import { useState } from 'react';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { diffChangeCount, fileDiff } from '../lib/file-diff';

/** What an agent last armed on a task, as the server sends it (DOR-3703). */
type AgentModeRecord = NonNullable<Task['agentModeRecord']>;

/**
 * One line saying an agent set this task's mode or approved it: who, when, and
 * old to new mode (Security ruling 8). Shown on the task itself, so a person
 * sees what an agent armed without opening Activity.
 */
export function TaskAgentModeNote({
  record,
  runtime,
}: {
  record: AgentModeRecord;
  /** The task's runtime, whose mode picker names the modes (`null`: the default). */
  runtime?: string | null;
}) {
  const permissionModeLabel = usePermissionModeLabel(runtime);
  // An agent names itself, so hidden characters are shown, as on the approval card.
  const who = record.agentName ? revealHiddenCharacters(record.agentName) : 'An agent';
  const mode = permissionModeLabel(record.mode);
  const was =
    record.previousMode && record.previousMode !== record.mode
      ? `, was ${permissionModeLabel(record.previousMode)}`
      : '';
  const what =
    record.kind === 'approved' ? `${who} approved it: ${mode}${was}` : `${who} set ${mode}${was}`;
  return (
    <div
      data-slot="task-agent-mode-note"
      className="text-muted-foreground min-w-0 text-xs break-words"
    >
      {what} · {formatRelativeTime(record.at)}
    </div>
  );
}

/** The mode a changed SKILL file caps a task's runs at (`dontAsk`). */
const CAP_MODE = 'dontAsk';

/**
 * What a refused request says, in the server's own sentence when it sent one.
 *
 * @param error - The thrown request error.
 */
function serverSentence(error: Error): string {
  const said = (error as Error & { body?: { message?: unknown } }).body?.message;
  return typeof said === 'string' ? said : error.message;
}

/**
 * The steps a capped task's latest run was refused, as a phrase, or `null`.
 * Read off the task's health, which names the latest finished run's refusals.
 *
 * @param task - The task.
 */
function refusedPhrase(task: Task): string | null {
  const tools = task.health?.reason?.tools ?? [];
  return listRefusedTools(tools.map(readableToolName))?.list ?? null;
}

/** Props for {@link FileCapReview}. */
interface FileCapReviewProps {
  task: Task;
  cap: NonNullable<Task['fileCap']>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Roughly a screen of the diff's body. Past it, the review says how many changes
 * there are, since some of them are out of sight. A line count is close enough
 * for one short label.
 */
const ONE_SCREEN_OF_LINES = 20;

/**
 * Bring a changed line into view in the diff's scrolling body, a third of the
 * way down. Set on the body directly: `scrollIntoView` can also move what is
 * behind a dialog. Stable, so it runs when the line mounts and never on a re-render.
 *
 * @param line - The first changed line, when it mounts.
 */
function openOnFirstChange(line: HTMLDivElement | null): void {
  const body = line?.closest<HTMLElement>('[data-slot="task-file-cap-review-scroll"]');
  if (!line || !body) return;
  const offset = line.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += offset - body.clientHeight / 3;
}

/**
 * The file as it changed, before anything is approved: what it lost and
 * gained since it was last approved, and Approve inside, bound to the file
 * this view shows. It opens on the first change, because in a long file that
 * is what a person is deciding on. A file that changed again is refused by the
 * server.
 */
function FileCapReview({ task, cap, open, onOpenChange }: FileCapReviewProps) {
  const approve = useApproveTaskFile();
  // The mode its runs go back to, named as the runtime's picker names it.
  const backTo = usePermissionModeLabel(task.runtime)(task.permissionMode);
  const lines = cap.current == null ? [] : fileDiff(cap.previous ?? null, cap.current);
  const firstChange = lines.findIndex((line) => line.kind !== 'same');
  const changes = diffChangeCount(lines);
  const hash = cap.hash;
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      {/* Clicks inside never reach the task row behind the dialog. */}
      {/* Sized to its content; a long diff scrolls in the body while Cancel and
          Approve stay pinned at the bottom. */}
      <ResponsiveDialogContent
        className="flex max-h-[85vh] flex-col sm:w-fit sm:max-w-2xl"
        onClick={(e) => e.stopPropagation()}
        data-slot="task-file-cap-review"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Review the changed file
            {lines.length > ONE_SCREEN_OF_LINES && changes > 0 && (
              <span
                data-slot="task-file-cap-change-count"
                className="text-muted-foreground ml-2 text-sm font-normal"
              >
                {changes === 1 ? '1 change' : `${changes} changes`}
              </span>
            )}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription data-slot="task-file-cap-review-body">
            {task.displayName ?? task.name}. Approving lifts the cap, so its runs go back to{' '}
            {backTo}.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody data-slot="task-file-cap-review-scroll" className="min-h-0">
          {lines.length > 0 ? (
            <pre
              data-slot="task-file-cap-diff"
              className="bg-muted rounded-md p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {lines.map((line, i) => (
                // A hanging indent: a wrapped line continues under its text, not its mark.
                <div
                  key={i}
                  ref={i === firstChange ? openOnFirstChange : undefined}
                  data-kind={line.kind}
                  className={cn(
                    'pl-[2ch] [text-indent:-2ch] break-words',
                    line.kind === 'added' && 'text-status-success-fg',
                    line.kind === 'removed' && 'text-destructive line-through',
                    line.kind === 'same' && 'text-muted-foreground'
                  )}
                >
                  {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                  {line.text}
                </div>
              ))}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm">The file is too long to show here.</p>
          )}
          {approve.isError && (
            <p className="text-destructive mt-2 text-sm">{serverSentence(approve.error)}</p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter data-slot="task-file-cap-review-footer" className="shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={hash == null || cap.current == null || approve.isPending}
            onClick={() => {
              if (hash == null) return;
              approve.mutate(
                { taskId: task.id, capAt: cap.at, hash },
                { onSuccess: () => onOpenChange(false) }
              );
            }}
          >
            Approve
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * Says a task runs capped at Never ask because its SKILL file changed outside
 * the task tools (DOR-3703, M4), in two lines: the cap and the steps it
 * refused, in the warning colour; then who can lift it. When its agent had no
 * ordinary chat lately, a person must: Approve file opens the diff first, and
 * Approve sits inside it. A capped task never reads as healthy.
 */
export function TaskFileCapNote({ task }: { task: Task }) {
  const capLabel = usePermissionModeLabel(task.runtime)(CAP_MODE);
  const [reviewing, setReviewing] = useState(false);
  const cap = task.fileCap;
  if (!cap) return null;
  const refused = refusedPhrase(task);
  return (
    <div data-slot="task-file-cap-note" className="flex min-w-0 flex-col gap-1 text-xs break-words">
      <span data-slot="task-file-cap-line" className="text-status-warning-fg">
        Capped at {capLabel}: its file changed outside the task tools.
        {refused && ` Refused: ${refused}.`}
      </span>
      {cap.needsPerson ? (
        <span
          data-slot="task-file-cap-needs-person"
          className="text-muted-foreground flex flex-wrap items-center gap-2"
        >
          <span>Its agent can’t lift this.</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-11 sm:h-auto"
            onClick={(e) => {
              e.stopPropagation();
              setReviewing(true);
            }}
          >
            Approve file
          </Button>
        </span>
      ) : (
        <span data-slot="task-file-cap-agent-lifts" className="text-muted-foreground">
          Its agent can accept the file from a chat.
        </span>
      )}
      <FileCapReview task={task} cap={cap} open={reviewing} onOpenChange={setReviewing} />
    </div>
  );
}
