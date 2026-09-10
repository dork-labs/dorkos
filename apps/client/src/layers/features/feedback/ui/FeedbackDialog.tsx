import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MessageSquare,
  Bug,
  Lightbulb,
  Stethoscope,
  MessagesSquare,
  User,
  VenetianMask,
  Lock,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
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
import { cn, getPlatform } from '@/layers/shared/lib';
import { useSendFeedback } from '../model/use-send-feedback';
import { useScreenshotAttachment } from '../model/use-screenshot-attachment';
import { appendElementIdentity, describeElement } from '../lib/element-identity';
import { FeedbackPreviewDialog, type FeedbackPreviewTab } from './FeedbackPreviewDialog';
import { PointAtElementOverlay, type PointAtElementPhase } from './PointAtElementOverlay';
import { ScreenshotField } from './ScreenshotField';

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
   * A screenshot to start attached, as an already-compressed `data:` URL.
   *
   * The dialog can be opened from somewhere that already has the picture — the
   * Dev Playground's captured-state showcase today — rather than only from an
   * empty form the user then fills.
   */
  initialScreenshotDataUrl?: string;
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
  feedback: 'What works, what does not, what you wish it did…',
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
 * from the app. Message-first: the kind and message lead, and diagnostics, a
 * screenshot, and the conversation excerpt live in a collapsible
 * "Attachments & details" panel that stays closed for a clean first impression
 * (design-decisions §2). The whole dialog is the screenshot's drop and paste
 * target while it is open, so a picture aimed anywhere on it lands in the
 * report. It also knows how to get out of its own way: "Point at element" hides
 * the dialog behind a picker, and what comes back is a bug report cropped to
 * the thing that looked wrong, with the element's name in the message —
 * everything already typed still exactly where it was left. Pressing Send
 * delivers the message to the DorkOS team;
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
  initialScreenshotDataUrl,
}: FeedbackDialogProps) {
  const isDesktop = !useIsMobile();
  const { isSubmitting, sessionId, buildDiagnostics, send } = useSendFeedback();
  const showConversation = Boolean(sessionId);
  // Obsidian's in-process transport forwards only the light telemetry event and
  // drops `screenshot` by design (feedback-attachments decision 8), so offering
  // the capture there would promise something the send path cannot keep. The
  // embed is the single place `DirectTransport` is built, and the same
  // `onOpen` sets this flag (`apps/obsidian-plugin/src/views/CopilotView.tsx`).
  const showScreenshot = !getPlatform().isEmbedded;

  const [kind, setKind] = useState<FeedbackSubmissionKind>(initialKind ?? 'feedback');
  const [message, setMessage] = useState(prefillMessage ?? '');
  const [contact, setContact] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [includeConversation, setIncludeConversation] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<FeedbackPreviewTab>('diagnostics');
  // `null` while the dialog is the thing on screen. Anything else means the
  // dialog has stepped aside for the picker and is waiting to come back with
  // what it found — the form's own state is untouched the whole time, which is
  // why a half-written report survives the round trip.
  const [pointPhase, setPointPhase] = useState<PointAtElementPhase | null>(null);
  // How many times this dialog has been opened, and the one token a pointing run
  // is measured against. A capture takes seconds, and the dialog can be closed
  // or reopened in them; without a way to notice, the picture, the element's
  // name and the switch to `bug` all land in a form somebody else has since
  // started. Counted in an EFFECT rather than in the reset below, because the
  // reset runs during render and a ref written there is a purity violation
  // React's own lint rule objects to — and this needs to be the kind of counter
  // you can trust rather than the kind you argue about.
  //
  // There is deliberately no SECOND token counting the runs themselves. Two
  // overlapping runs would need a second pick while the first was capturing, and
  // the picker refuses clicks once aiming is over — so a run counter would guard
  // a state that cannot be reached, and an unreachable guard is worse than none:
  // it reads as protection and is never exercised.
  const openEpoch = useRef(0);
  useEffect(() => {
    openEpoch.current += 1;
  }, [open]);
  // Whether the person has touched the attachment toggles themselves. Once they
  // have, nothing re-derives those from the kind behind their back — see
  // `onPointSelect`.
  const [attachmentsTouched, setAttachmentsTouched] = useState(false);
  // The attachments panel starts shut, and both of these can happen while it
  // is: a drag needs somewhere visible to aim, and a paste (⌘V works anywhere
  // on the dialog) otherwise lands a picture the person who pasted it never
  // sees. Either one reveals the panel; closing it again stays theirs to do.
  const screenshot = useScreenshotAttachment({
    enabled: open && showScreenshot,
    onFileDragIn: () => setPanelOpen(true),
    onAttached: () => setPanelOpen(true),
  });

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
      setAttachmentsTouched(false);
      // A picker left mid-aim by a host that closed the dialog out from under it
      // must not be waiting on the next open — that would show a crosshair over
      // an app nobody asked to point at. A capture that is STILL RUNNING is
      // disowned by `openEpoch`, which this reopen has already moved.
      setPointPhase(null);
      // A picture from the last report must never ride along with the next one,
      // and a surface that cannot send one must not be holding one either — so
      // the embedded transport starts empty whatever a caller passed.
      const initialShot = showScreenshot ? initialScreenshotDataUrl : undefined;
      screenshot.reset(initialShot);
      if (initialShot) setPanelOpen(true);
    }
  }

  /** Re-derive the attachment toggles from a kind. */
  function applyKindDefaults(next: FeedbackSubmissionKind): void {
    // Thread the crash flag so switching kind on a crash-prefilled report keeps
    // diagnostics on (the crash stack rides in diagnostics — dropping it here
    // would silently discard it).
    const defaults = defaultsForKind(next, showConversation, Boolean(crashStack));
    setIncludeDiagnostics(defaults.diagnostics);
    setIncludeConversation(defaults.conversation);
  }

  function onKindChange(next: FeedbackSubmissionKind): void {
    setKind(next);
    applyKindDefaults(next);
  }

  function openPreview(tab: FeedbackPreviewTab): void {
    setPreviewTab(tab);
    setPreviewOpen(true);
  }

  /**
   * Come back from the picker with the element the person aimed at.
   *
   * The identity is read FIRST and synchronously, off the element as it was
   * clicked — the capture that follows takes seconds, and by the time it settles
   * a re-render may have replaced the node it names.
   */
  async function onPointSelect(element: Element): Promise<void> {
    const myEpoch = openEpoch.current;
    const identity = describeElement(element);
    setPointPhase('capturing');
    // The crop can still fail (it toasts its own refusal), and the identity is
    // recorded either way: knowing WHICH element is the part of this gesture
    // that a failed screenshot does not take away.
    await screenshot.captureElement(element);
    // Seconds have passed, and the dialog may have been closed or reopened in
    // them. Everything below would then be written into a form that has moved
    // on: a picture nobody asked for, a kind nobody chose, and the name of an
    // element nobody pointed at in THIS report. The attachment hook already
    // drops the image on its own generation check (`reset` bumps it); this is
    // the other half.
    if (myEpoch !== openEpoch.current) return;
    setPointPhase(null);
    const composed = appendElementIdentity(message, identity);
    setMessage(composed.message);
    if (composed.identityDropped) {
      // Never silently: the name is the whole point of the gesture, and a report
      // that quietly lacks it looks like one where the gesture worked.
      toast.error(
        'Your message is too long to add the element’s name to it. The screenshot is still attached.'
      );
    }
    // Pointing at something broken is a bug report. The KIND changes; the
    // attachment toggles do not, unless the person has left them at whatever we
    // chose. Re-deriving them here would switch Diagnostics back on for someone
    // who had just deliberately switched it off, which is the one thing this
    // dialog promises never to do (feedback-attachments decision 12).
    setKind('bug');
    if (!attachmentsTouched) applyKindDefaults('bug');
    setPanelOpen(true);
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
      ...(showScreenshot && screenshot.dataUrl ? { screenshotDataUrl: screenshot.dataUrl } : {}),
    });
    if (ok) onOpenChange(false);
  }

  // Sending mid-compression would drop the picture the user just chose without
  // saying so, so the button waits for it.
  const canSend = message.trim().length > 0 && !isSubmitting && !screenshot.isPreparing;

  const panelSummary = [
    includeDiagnostics ? 'Diagnostics on' : null,
    showConversation && includeConversation ? 'Conversation on' : null,
    showScreenshot && screenshot.dataUrl ? 'Screenshot on' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The whole dialog takes the paste and the drop — a picture aimed anywhere on
  // it is a picture meant for it, and the drop target being one small box is the
  // usual reason a drag "does nothing".
  const captureHandlers = showScreenshot ? screenshot.handlers : undefined;

  // Stepping aside, not closing: `open` — the prop the form's reset watches — is
  // untouched, so the message, the toggles and the contact line are all still
  // there when the picker hands control back. Only what is on screen changes.
  const isPointing = pointPhase !== null;

  return (
    <>
      {isPointing && (
        <PointAtElementOverlay
          phase={pointPhase}
          onSelect={(element) => void onPointSelect(element)}
          onCancel={() => setPointPhase(null)}
        />
      )}
      <ResponsiveDialog open={open && !isPointing} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent
          {...captureHandlers}
          className={cn(
            'max-h-[85vh]',
            isDesktop && 'max-w-md',
            screenshot.isDraggingOver && 'ring-primary ring-2'
          )}
        >
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
                    Your report won’t include your name or email. You can still track it in this
                    app; add a contact below if you’d like a reply.
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
                {/* Screenshot slot. Absent under the in-process transport, which
                  drops the field on the way out (feedback-attachments §8). */}
                {showScreenshot && (
                  <ScreenshotField
                    dataUrl={screenshot.dataUrl}
                    isPreparing={screenshot.isPreparing}
                    isDraggingOver={screenshot.isDraggingOver}
                    onPick={(file) => void screenshot.attach(file)}
                    onCapture={() => void screenshot.capture()}
                    onPointAtElement={() => setPointPhase('picking')}
                    onRemove={screenshot.clear}
                    onPreview={() => openPreview('screenshot')}
                    isMobile={!isDesktop}
                  />
                )}

                {/* Two side-by-side toggles */}
                <div className={cn('grid gap-2', showConversation ? 'grid-cols-2' : 'grid-cols-1')}>
                  <AttachmentToggle
                    id="feedback-diagnostics"
                    icon={Stethoscope}
                    label="Diagnostics"
                    summary="Version, platform, and recent errors."
                    checked={includeDiagnostics}
                    onCheckedChange={(next) => {
                      setAttachmentsTouched(true);
                      setIncludeDiagnostics(next);
                    }}
                    onPreview={() => openPreview('diagnostics')}
                  />
                  {showConversation && (
                    <AttachmentToggle
                      id="feedback-conversation"
                      icon={MessagesSquare}
                      label="Conversation"
                      summary="So we can see what led to the bug."
                      checked={includeConversation}
                      onCheckedChange={(next) => {
                        setAttachmentsTouched(true);
                        setIncludeConversation(next);
                      }}
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
                placeholder="Email or handle, if you’d like a reply"
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
            {...(showScreenshot && screenshot.dataUrl
              ? { screenshotDataUrl: screenshot.dataUrl }
              : {})}
          />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
