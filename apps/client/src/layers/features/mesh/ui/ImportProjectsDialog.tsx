import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogBody,
  Button,
} from '@/layers/shared/ui';
import { useImportProjectsStore } from '@/layers/shared/model';
import { DiscoveryView } from './DiscoveryView';

/**
 * The single "bring in existing projects" surface — a global dialog opened from
 * the gallery lead-out, the naming step's "Import instead?", the sidebar Add
 * menu, the command palette, and the agents empty state.
 *
 * It wraps {@link DiscoveryView} (scan + approve) and gives the flow the ending
 * it used to lack: a live join count while scanning, and a completion summary
 * ("N projects joined") with a single **Done** that closes and lands the user
 * on the Agents page. Bringing in nothing is a sane no-op — Done just closes.
 *
 * Controlled entirely by `useImportProjectsStore`; mounted once in the app shell.
 */
export function ImportProjectsDialog() {
  const isOpen = useImportProjectsStore((s) => s.isOpen);
  const close = useImportProjectsStore((s) => s.close);
  const navigate = useNavigate();

  // Projects brought in during this open. Reset each time the dialog opens.
  const [joinedCount, setJoinedCount] = useState(0);
  const [showSummary, setShowSummary] = useState(false);

  // Reset the session counters whenever the dialog transitions to open.
  const [prevIsOpen, setPrevIsOpen] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setJoinedCount(0);
      setShowSummary(false);
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) close();
  }

  /** Finish importing: celebrate if anything joined, otherwise just close. */
  function handleDone() {
    if (joinedCount > 0 && !showSummary) {
      setShowSummary(true);
      return;
    }
    close();
    if (joinedCount > 0) navigate({ to: '/agents' });
  }

  const joinedLabel = `${joinedCount} project${joinedCount === 1 ? '' : 's'} joined`;

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-2xl">
        <ResponsiveDialogHeader className="shrink-0">
          <ResponsiveDialogTitle>Bring in existing projects</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {showSummary
              ? 'All set — your projects are ready to manage in DorkOS.'
              : 'Scan your machine for existing projects and add the ones you want to manage.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {showSummary ? (
          <ResponsiveDialogBody className="mt-2">
            <div
              className="flex flex-col items-center justify-center gap-3 py-10 text-center"
              data-testid="import-complete"
            >
              <CheckCircle2 className="text-primary size-12" aria-hidden />
              <p className="text-lg font-semibold" data-testid="import-joined-summary">
                {joinedLabel}
              </p>
              <p className="text-muted-foreground text-sm">
                Assign agents, schedule tasks, and connect Slack or Telegram from the Agents page.
              </p>
            </div>
          </ResponsiveDialogBody>
        ) : (
          <ResponsiveDialogBody className="mt-2 overflow-y-auto">
            <DiscoveryView onRegistered={() => setJoinedCount((n) => n + 1)} />
          </ResponsiveDialogBody>
        )}

        <ResponsiveDialogFooter className="shrink-0 sm:justify-between">
          {!showSummary && joinedCount > 0 ? (
            <span className="text-muted-foreground text-sm" data-testid="import-joined-count">
              {joinedLabel}
            </span>
          ) : (
            <span />
          )}
          <Button onClick={handleDone} data-testid="import-done">
            Done
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
