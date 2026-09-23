/**
 * One step of a hosted-community flow, and the two frames that draw it.
 *
 * A step is data (a title, a sentence, a body and its actions) so the same
 * step renders inside the real dialog and, unchanged, in the Dev Playground's
 * gallery of every state at phone, tablet and desktop widths.
 *
 * @module features/community-hosting/ui/hosting-step
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { openExternalLink } from '@/layers/shared/lib';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import type { HostingNotice } from '../model/use-claim-and-connect';

/** What one step shows. */
export interface HostingStep {
  title: string;
  description?: ReactNode;
  body?: ReactNode;
  /** The step's buttons, primary last. */
  actions: ReactNode;
}

/** Props for {@link HostingStepDialog}. */
export interface HostingStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: HostingStep;
  /** Stops a click outside or Escape from closing it, while something must not be interrupted. */
  locked?: boolean;
}

/** Draw a step in the app's responsive dialog: centered on desktop, a sheet on a phone. */
export function HostingStepDialog({ open, onOpenChange, step, locked }: HostingStepDialogProps) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => (locked && !next ? undefined : onOpenChange(next))}
    >
      <ResponsiveDialogContent className="!min-h-0 sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{step.title}</ResponsiveDialogTitle>
          {step.description !== undefined && (
            <ResponsiveDialogDescription>{step.description}</ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>
        {step.body !== undefined && (
          <ResponsiveDialogBody className="space-y-4 py-2">{step.body}</ResponsiveDialogBody>
        )}
        <ResponsiveDialogFooter className="gap-2 sm:gap-2">{step.actions}</ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * Draw a step flat on the page, laid out as the dialog lays it out. For the
 * Dev Playground, where every state is shown at once.
 */
export function HostingStepPreview({ step }: { step: HostingStep }) {
  return (
    <section
      aria-label={step.title}
      className="bg-background w-full max-w-lg space-y-4 rounded-lg border p-4 shadow-sm"
    >
      <header className="space-y-1.5">
        <h3 className="text-lg leading-none font-semibold">{step.title}</h3>
        {step.description !== undefined && (
          <p className="text-muted-foreground text-sm">{step.description}</p>
        )}
      </header>
      {step.body !== undefined && <div className="space-y-4">{step.body}</div>}
      <footer className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {step.actions}
      </footer>
    </section>
  );
}

/**
 * Say what went wrong: the service's own words with the link it names, or one
 * sentence of ours. Rendered as text only; nothing the service sends is ever
 * treated as markup.
 */
export function HostingNoticeView({ notice }: { notice: HostingNotice }) {
  if ('message' in notice) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {notice.message}
      </p>
    );
  }
  const { title, detail, actionUrl, actionLabel } = notice.problem;
  return (
    <div
      role="alert"
      className="border-status-warning-border bg-status-warning-bg text-status-warning-fg space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="font-medium break-words">{title}</p>
      {detail && <p className="break-words">{detail}</p>}
      {actionUrl && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openExternalLink(actionUrl)}
        >
          {actionLabel ?? 'Open your account'}
          <ExternalLink className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}
