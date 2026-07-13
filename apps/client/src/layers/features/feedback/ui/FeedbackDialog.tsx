import { useState, type FormEvent } from 'react';
import { MessageSquare, Bug, Lightbulb } from 'lucide-react';
import type { FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  Button,
  Textarea,
  Input,
  Label,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useSendFeedback } from '../model/use-send-feedback';

interface FeedbackDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
}

/** The three feedback kinds, in the order they appear in the selector. */
const KINDS: { value: FeedbackSubmissionKind; label: string; icon: typeof MessageSquare }[] = [
  { value: 'feedback', label: 'Feedback', icon: MessageSquare },
  { value: 'bug', label: 'Bug', icon: Bug },
  { value: 'idea', label: 'Idea', icon: Lightbulb },
];

/** Placeholder text per kind — a gentle nudge toward a useful message. */
const PLACEHOLDER: Record<FeedbackSubmissionKind, string> = {
  feedback: 'What works, what does not, what you wish it did...',
  bug: 'What happened, and what did you expect instead?',
  idea: 'What would you like DorkOS to do?',
};

/**
 * A small dialog for sending feedback, a bug report, or a feature idea straight
 * from the cockpit. Pressing Send delivers the message to the DorkOS team; it is
 * not telemetry and is sent only when the user submits it. The GitHub option
 * stays available in the help menu for developers who want an issue thread.
 */
export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const isDesktop = !useIsMobile();
  const { isSubmitting, send } = useSendFeedback();
  const [kind, setKind] = useState<FeedbackSubmissionKind>('feedback');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');

  // Reset the form each time the dialog (re)opens, adjusting state during render
  // rather than in an effect (the React-recommended pattern for deriving state
  // from a prop change — no cascading render, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKind('feedback');
      setMessage('');
      setContact('');
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const ok = await send({ kind, message, contact });
    if (ok) onOpenChange(false);
  }

  const canSend = message.trim().length > 0 && !isSubmitting;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-sm font-medium">
            Send feedback
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-muted-foreground text-xs">
            Goes straight to the DorkOS team. Sent only when you press Send.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4 px-4 pb-1 sm:px-0">
          {/* Kind selector */}
          <div
            role="radiogroup"
            aria-label="What kind of feedback"
            className="bg-muted/50 grid grid-cols-3 gap-1 rounded-lg p-1"
          >
            {KINDS.map(({ value, label, icon: Icon }) => {
              const selected = kind === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setKind(value)}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-150',
                    selected
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Message */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feedback-message" className="sr-only">
              Your message
            </Label>
            <Textarea
              id="feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={PLACEHOLDER[kind]}
              rows={5}
              maxLength={4000}
              className="resize-none"
            />
          </div>

          {/* Optional contact */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feedback-contact" className="text-muted-foreground text-xs">
              Contact (optional)
            </Label>
            <Input
              id="feedback-contact"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Email or handle, if you'd like a reply"
              maxLength={254}
              autoComplete="off"
            />
          </div>

          <ResponsiveDialogFooter className="px-0">
            <Button type="submit" disabled={!canSend}>
              {isSubmitting ? 'Sending…' : 'Send'}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
