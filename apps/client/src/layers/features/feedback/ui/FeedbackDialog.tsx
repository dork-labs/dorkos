import { useState, type FormEvent } from 'react';
import {
  MessageSquare,
  Bug,
  Lightbulb,
  Stethoscope,
  MessagesSquare,
  ImagePlus,
  Crosshair,
  User,
  VenetianMask,
  Lock,
  ChevronDown,
} from 'lucide-react';
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
  Checkbox,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useSendFeedback } from '../model/use-send-feedback';
import { FeedbackPreviewDialog, type FeedbackPreviewTab } from './FeedbackPreviewDialog';

interface FeedbackDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Which kind to preselect when the dialog opens. Defaults to `feedback`. */
  initialKind?: FeedbackSubmissionKind;
  /** A starting message (a crash stub, or a failed-action summary). */
  prefillMessage?: string;
  /** A crash stack trace, folded into the bug report's diagnostics. */
  crashStack?: string;
  /**
   * The signed-in user, when one is resolvable. Drives the identity line; the
   * server is the authority on identity (this is display only). Passed in by the
   * dialog host so this feature never imports the auth feature's hooks.
   */
  currentUser?: { email: string; name?: string } | null;
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

/** Per-kind attachment defaults (design-decisions §2). */
function defaultsForKind(
  kind: FeedbackSubmissionKind,
  hasSession: boolean,
  hasCrash: boolean
): { diagnostics: boolean; conversation: boolean } {
  return {
    // Bug → diagnostics on; a crash report always carries its stack.
    diagnostics: kind === 'bug' || hasCrash,
    // Conversation only when a session is in context, and only for bugs.
    conversation: kind === 'bug' && hasSession,
  };
}

/** One of the two side-by-side attachment toggles (Diagnostics / Conversation). */
function AttachmentToggle({
  id,
  icon: Icon,
  label,
  summary,
  checked,
  onCheckedChange,
  onPreview,
}: {
  id: string;
  icon: typeof MessageSquare;
  label: string;
  summary: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onPreview: () => void;
}) {
  return (
    <div className="bg-muted/30 flex flex-col gap-1.5 rounded-md border p-2.5">
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
        <Label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </Label>
      </div>
      <p className="text-muted-foreground text-xs">{summary}</p>
      <button
        type="button"
        onClick={onPreview}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring self-start rounded-sm text-xs underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
      >
        View full preview
      </button>
    </div>
  );
}

/**
 * A small dialog for sending feedback, a bug report, or a feature idea straight
 * from the cockpit. Message-first: the kind and message lead, and diagnostics,
 * a screenshot slot, and the conversation excerpt live in a collapsible
 * "Attachments & details" panel that stays closed for a clean first impression
 * (design-decisions §2). Pressing Send delivers the message to the DorkOS team;
 * it is not telemetry and is sent only when the user submits it. The GitHub
 * option stays available in the help menu for developers who want an issue
 * thread.
 */
export function FeedbackDialog({
  open,
  onOpenChange,
  initialKind,
  prefillMessage,
  crashStack,
  currentUser,
}: FeedbackDialogProps) {
  const isDesktop = !useIsMobile();
  const { isSubmitting, sessionId, buildDiagnostics, send } = useSendFeedback();
  const showConversation = Boolean(sessionId);

  const [kind, setKind] = useState<FeedbackSubmissionKind>(initialKind ?? 'feedback');
  const [message, setMessage] = useState(prefillMessage ?? '');
  const [contact, setContact] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [includeConversation, setIncludeConversation] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<FeedbackPreviewTab>('diagnostics');

  // Reset the form each time the dialog (re)opens, adjusting state during render
  // rather than in an effect (the React-recommended pattern for deriving state
  // from a prop change — no cascading render, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const nextKind = initialKind ?? 'feedback';
      const defaults = defaultsForKind(nextKind, showConversation, Boolean(crashStack));
      setKind(nextKind);
      setMessage(prefillMessage ?? '');
      setContact('');
      setAnonymous(false);
      setIncludeDiagnostics(defaults.diagnostics);
      setIncludeConversation(defaults.conversation);
      // Open the panel up front only when there is already something attached to
      // see (a crash report, or a bug with diagnostics on) — otherwise stay clean.
      setPanelOpen(defaults.diagnostics || defaults.conversation);
      setPreviewOpen(false);
    }
  }

  function onKindChange(next: FeedbackSubmissionKind): void {
    setKind(next);
    // Thread the crash flag so switching kind on a crash-prefilled report keeps
    // diagnostics on (the crash stack rides in diagnostics — dropping it here
    // would silently discard it).
    const defaults = defaultsForKind(next, showConversation, Boolean(crashStack));
    setIncludeDiagnostics(defaults.diagnostics);
    setIncludeConversation(defaults.conversation);
  }

  function openPreview(tab: FeedbackPreviewTab): void {
    setPreviewTab(tab);
    setPreviewOpen(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const ok = await send({
      kind,
      message,
      contact,
      includeDiagnostics,
      includeConversation,
      anonymous,
      ...(crashStack ? { crashStack } : {}),
    });
    if (ok) onOpenChange(false);
  }

  const canSend = message.trim().length > 0 && !isSubmitting;

  const panelSummary = [
    includeDiagnostics ? 'Diagnostics on' : null,
    showConversation && includeConversation ? 'Conversation on' : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
                  onClick={() => onKindChange(value)}
                  className={cn(
                    'focus-visible:ring-ring flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
                    selected
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
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

          {/* Identity line (only when a signed-in user is resolvable) */}
          {currentUser && (
            <div className="flex flex-col gap-1">
              <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                {anonymous ? (
                  <VenetianMask className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <User className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {anonymous ? 'Sending anonymously' : `Sending as ${currentUser.email}`}
                </span>
                <button
                  type="button"
                  onClick={() => setAnonymous((a) => !a)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
                >
                  {anonymous ? 'Use my account' : 'Send anonymously'}
                </button>
              </div>
              {anonymous && (
                <p className="text-muted-foreground text-xs">
                  Your report won&apos;t include your name or email. You can still track it in this
                  app; add a contact below if you&apos;d like a reply.
                </p>
              )}
            </div>
          )}

          {/* Attachments & details */}
          <Collapsible open={panelOpen} onOpenChange={setPanelOpen}>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full items-center justify-between rounded-md text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none">
              <span>Attachments &amp; details</span>
              <span className="flex items-center gap-1.5">
                {panelSummary && <span className="text-muted-foreground">{panelSummary}</span>}
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform duration-150',
                    panelOpen && 'rotate-180'
                  )}
                  aria-hidden
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3 pt-3">
              {/* Screenshot area — placeholder only (a separate round adds capture) */}
              <div className="flex flex-col gap-2">
                <div
                  aria-disabled
                  className="border-muted-foreground/25 text-muted-foreground flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-4 text-xs opacity-70"
                >
                  <ImagePlus className="size-4" aria-hidden />
                  Add screenshot (coming soon)
                </div>
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs opacity-70">
                  <Crosshair className="size-3.5" aria-hidden />
                  Point at element (coming soon)
                </div>
              </div>

              {/* Two side-by-side toggles */}
              <div className={cn('grid gap-2', showConversation ? 'grid-cols-2' : 'grid-cols-1')}>
                <AttachmentToggle
                  id="feedback-diagnostics"
                  icon={Stethoscope}
                  label="Diagnostics"
                  summary="Version, platform, and recent errors."
                  checked={includeDiagnostics}
                  onCheckedChange={setIncludeDiagnostics}
                  onPreview={() => openPreview('diagnostics')}
                />
                {showConversation && (
                  <AttachmentToggle
                    id="feedback-conversation"
                    icon={MessagesSquare}
                    label="Conversation"
                    summary="So we can see what led to the bug."
                    checked={includeConversation}
                    onCheckedChange={setIncludeConversation}
                    onPreview={() => openPreview('conversation')}
                  />
                )}
              </div>

              {/* Privacy line */}
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Lock className="size-3 shrink-0" aria-hidden />
                Private. Only the DorkOS core team sees these. Never public.
              </p>
            </CollapsibleContent>
          </Collapsible>

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

        <FeedbackPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          initialTab={previewTab}
          diagnostics={buildDiagnostics(crashStack ? { crashStack } : undefined)}
          kind={kind}
          showConversation={showConversation}
          sessionId={sessionId}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
