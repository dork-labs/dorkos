import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  MAX_FEEDBACK_MESSAGE_LEN,
  type FeedbackSubmissionKind,
} from '@dorkos/shared/telemetry-events';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  Textarea,
  Label,
} from '@/layers/shared/ui';
import { useIsMobile, useReportIssue } from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
import { useSendFeedback } from '../model/use-send-feedback';
import { useScreenshotAttachment } from '../model/use-screenshot-attachment';
import {
  describeElement,
  nameElement,
  type ElementIdentity,
  type ElementName,
} from '../lib/element-identity';
import { looksLikeEmail, readReplyEmail, rememberReplyEmail } from '../lib/reply-email';
import { elementCaption, placeholderForElement, removeElementLabel } from '../lib/element-copy';
import { FeedbackPreviewDialog, type FeedbackPreviewTab } from './FeedbackPreviewDialog';
import { PointAtElementOverlay, type PointAtElementPhase } from './PointAtElementOverlay';
import { ComposerToolbar } from './ComposerToolbar';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { AlsoSendChip } from './AlsoSendChip';
import { ReplyToField } from './ReplyToField';
import { KindPills } from './KindPills';
import { FeedbackFormFooter } from './FeedbackFormFooter';

interface FeedbackDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Which kind to preselect when the dialog opens on an empty form. Defaults to `feedback`. */
  initialKind?: FeedbackSubmissionKind;
  /** A starting message (a crash stub, or a failed-action summary). Replaces any draft. */
  prefillMessage?: string;
  /** A crash stack trace, folded into the bug report's diagnostics. Replaces any draft. */
  crashStack?: string;
  /**
   * A screenshot to start attached, as an already-compressed `data:` URL.
   * Replaces any draft.
   *
   * The dialog can be opened from somewhere that already has the picture — the
   * Dev Playground's captured-state showcase today — rather than only from an
   * empty form the user then fills.
   */
  initialScreenshotDataUrl?: string;
  /**
   * The signed-in user, when one is resolvable. Drives the identity line; the
   * server is the authority on identity (this is display only). Passed in by the
   * dialog host so this feature never imports the auth feature's hooks. `null`
   * (login off, or signed out) shows the "Your email" field instead, because an
   * address typed there is then the only way the team can ever write back.
   */
  currentUser?: { email: string; name?: string } | null;
}

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

/**
 * A small dialog for sending feedback, a bug report, or a feature idea straight
 * from the app, laid out like a chat composer (feedback-form-redesign, DOR-2232):
 * the kind, then one message box with everything attached living inside its
 * border (the thumbnails, then a toolbar to capture the app, point at the part
 * that looks wrong, or add an image), then the "Also send" chips, then who the
 * team can reply to, then Send.
 *
 * **Words are required.** Pointing at an element attaches it as its own field;
 * it never writes into the message, so Send stays off until the person has said
 * something, and the report's title is always their own words.
 *
 * **The draft is kept.** Closing by accident and reopening finds everything where
 * it was left. The form starts over only after a successful send, or when a
 * caller opens it with something of its own to say (a crash report, a
 * failed-action summary, a picture).
 *
 * The whole dialog is the drop and paste target for an image. "Point at it" hides
 * the dialog behind a picker, and what comes back is the crop, the element's
 * name, and the kind switched to Bug. Pressing Send delivers the report to the
 * DorkOS team; it is not telemetry and is sent only when the person submits it.
 * A public GitHub issue is one link away in the footer.
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
  const { isSubmitting, sessionId, route, buildDiagnostics, send } = useSendFeedback();
  const reportIssue = useReportIssue();
  const showConversation = Boolean(sessionId);
  // Obsidian's in-process transport forwards only the light telemetry event and
  // drops `screenshot` by design (feedback-attachments decision 8), so offering
  // the capture there would promise something the send path cannot keep. The
  // embed is the single place `DirectTransport` is built, and the same
  // `onOpen` sets this flag (`apps/obsidian-plugin/src/views/CopilotView.tsx`).
  const showScreenshot = !getPlatform().isEmbedded;
  const signedIn = Boolean(currentUser);

  const messageId = useId();

  const [kind, setKind] = useState<FeedbackSubmissionKind>(initialKind ?? 'feedback');
  const [message, setMessage] = useState(prefillMessage ?? '');
  // The reply address a signed-out reporter types. Starts with the one they
  // used last time, when this browser remembers one.
  const [contact, setContact] = useState(readReplyEmail);
  const [anonymous, setAnonymous] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [includeConversation, setIncludeConversation] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<FeedbackPreviewTab>('diagnostics');
  // The element the person pointed at, and the picture that pointing produced.
  // Kept apart because the picture can be replaced by a capture or a paste
  // afterwards, and the element's name is still worth sending when it is.
  const [element, setElement] = useState<ElementIdentity | null>(null);
  const [elementShot, setElementShot] = useState<string | null>(null);
  // What to call it, read off the page at the moment it was clicked.
  const [pointedName, setPointedName] = useState<ElementName | null>(null);
  // `null` while the dialog is the thing on screen. Anything else means the
  // dialog has stepped aside for the picker and is waiting to come back with
  // what it found — the form's own state is untouched the whole time, which is
  // why a half-written report survives the round trip.
  const [pointPhase, setPointPhase] = useState<PointAtElementPhase | null>(null);
  // How many times the form has started over, and the one token a pointing run
  // is measured against. A capture takes seconds, and the form can be reset in
  // them (a caller reopening it with a crash report); without a way to notice,
  // the picture, the element's name and the switch to `bug` all land in a report
  // somebody else has since started. Counted in state and mirrored into a ref in
  // an EFFECT, because the reset runs during render and a ref written there is a
  // purity violation React's own lint rule objects to.
  //
  // There is deliberately no SECOND token counting the runs themselves. Two
  // overlapping runs would need a second pick while the first was capturing, and
  // the picker refuses clicks once aiming is over — so a run counter would guard
  // a state that cannot be reached, and an unreachable guard is worse than none:
  // it reads as protection and is never exercised.
  const [draftEpoch, setDraftEpoch] = useState(0);
  const draftEpochRef = useRef(draftEpoch);
  useEffect(() => {
    draftEpochRef.current = draftEpoch;
  }, [draftEpoch]);
  // Whether the person has touched the "Also send" chips themselves. Once they
  // have, nothing re-derives those from the kind behind their back — see
  // `onPointSelect`.
  const [attachmentsTouched, setAttachmentsTouched] = useState(false);
  // The crash stack this draft was opened with. Held here rather than read off
  // the prop, because the host clears its prefill on close: a crash report
  // closed by accident and reopened keeps its draft, and must keep its stack.
  const [draftCrashStack, setDraftCrashStack] = useState(crashStack);
  // The conversation this draft was started beside. "This conversation" means
  // that one; a draft carried onto another session's page must not quietly
  // attach the new session's transcript instead.
  const [draftSessionId, setDraftSessionId] = useState(sessionId);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const screenshot = useScreenshotAttachment({ enabled: open && showScreenshot });

  const hasWords = message.trim().length > 0;
  const hasDraft = hasWords || screenshot.dataUrl !== null || element !== null;

  // On each open, keep the draft or start over, adjusting state during render
  // rather than in an effect (the React-recommended pattern for deriving state
  // from a prop change — no cascading render, no effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPreviewOpen(false);
      // A picker left mid-aim by a host that closed the dialog out from under it
      // must not be waiting on the next open — that would show a crosshair over
      // an app nobody asked to point at.
      setPointPhase(null);
      // A surface that cannot send a picture must not be holding one either, so
      // the embedded transport ignores whatever a caller passed.
      const initialShot = showScreenshot ? initialScreenshotDataUrl : undefined;
      const callerBroughtContent = Boolean(prefillMessage || crashStack || initialShot);
      if (callerBroughtContent || !hasDraft) {
        const nextKind = initialKind ?? 'feedback';
        const defaults = defaultsForKind(nextKind, showConversation, Boolean(crashStack));
        setKind(nextKind);
        setMessage(prefillMessage ?? '');
        setContact(readReplyEmail());
        setAnonymous(false);
        setIncludeDiagnostics(defaults.diagnostics);
        setIncludeConversation(defaults.conversation);
        setAttachmentsTouched(false);
        setElement(null);
        setElementShot(null);
        setDraftCrashStack(crashStack);
        setDraftSessionId(sessionId);
        // A picture from the last report must never ride along with the next
        // one. A capture that is STILL RUNNING is disowned by the epoch.
        screenshot.reset(initialShot);
        setDraftEpoch((epoch) => epoch + 1);
      } else if (sessionId !== draftSessionId) {
        // Kept draft, different page: the person chose "This conversation"
        // about the other one. Off, and theirs to turn back on.
        setIncludeConversation(false);
        setDraftSessionId(sessionId);
      }
    }
  }

  /** Re-derive the "Also send" chips from a kind. */
  function applyKindDefaults(next: FeedbackSubmissionKind): void {
    // Thread the crash flag so switching kind on a crash-prefilled report keeps
    // diagnostics on (the crash stack rides in diagnostics — dropping it here
    // would silently discard it).
    const defaults = defaultsForKind(next, showConversation, Boolean(draftCrashStack));
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
  async function onPointSelect(target: Element): Promise<void> {
    const myEpoch = draftEpochRef.current;
    const identity = describeElement(target);
    const name = nameElement(target);
    // Pointing again replaces the last element, and its crop goes first: were
    // the new capture to fail, the old picture would otherwise stay attached
    // under the new element's name.
    if (elementShot && screenshot.dataUrl === elementShot) screenshot.clear();
    setElementShot(null);
    setPointPhase('capturing');
    // The crop can still fail (it toasts its own refusal), and the identity is
    // recorded either way: knowing WHICH element is the part of this gesture
    // that a failed screenshot does not take away.
    const shot = await screenshot.captureElement(target);
    // Seconds have passed, and the form may have started over in them.
    // Everything below would then be written into a report that has moved on:
    // a kind nobody chose and the name of an element nobody pointed at in THIS
    // report. The attachment hook already drops the image on its own
    // generation check (`reset` bumps it); this is the other half.
    if (myEpoch !== draftEpochRef.current) return;
    setPointPhase(null);
    setElement(identity);
    setPointedName(name);
    setElementShot(shot);
    // Pointing at something broken is a bug report. The KIND changes; the
    // "Also send" chips do not, unless the person has left them at whatever we
    // chose. Re-deriving them here would switch Diagnostics back on for someone
    // who had just deliberately switched it off, which is the one thing this
    // dialog promises never to do (feedback-attachments decision 12).
    setKind('bug');
    if (!attachmentsTouched) applyKindDefaults('bug');
  }

  /** Take the pointed-at element off the report, and its picture with it. */
  function removeElement(): void {
    if (elementShot && screenshot.dataUrl === elementShot) screenshot.clear();
    setElement(null);
    setElementShot(null);
  }

  /** Empty the draft, so the next open starts over. Called once a report is with the team. */
  function clearDraft(): void {
    setMessage('');
    setElement(null);
    setElementShot(null);
    setAttachmentsTouched(false);
    setDraftCrashStack(undefined);
    screenshot.clear();
  }

  // Sending mid-compression would drop the picture the person just chose without
  // saying so, so the button waits for it. The element never counts as words.
  const canSend = hasWords && !isSubmitting && !screenshot.isPreparing;

  // Who the team can write back to, for the thank-you to name.
  const notifyEmail = signedIn
    ? anonymous
      ? undefined
      : currentUser?.email
    : looksLikeEmail(contact)
      ? contact.trim()
      : undefined;

  async function submit(): Promise<void> {
    if (!canSend) return;
    const ok = await send({
      kind,
      message,
      // A signed-in reporter's address comes from their account, server-side;
      // the field is not on screen for them, so nothing typed rides along.
      ...(signedIn ? {} : { contact }),
      includeDiagnostics,
      includeConversation,
      anonymous,
      ...(draftCrashStack ? { crashStack: draftCrashStack } : {}),
      ...(showScreenshot && screenshot.dataUrl ? { screenshotDataUrl: screenshot.dataUrl } : {}),
      ...(element ? { element } : {}),
      ...(notifyEmail ? { notifyEmail } : {}),
    });
    if (!ok) return;
    if (!signedIn) rememberReplyEmail(contact);
    clearDraft();
    onOpenChange(false);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit();
  }

  /** Put the caret at the end of the message, for the dialog's open focus. */
  function focusMessage(e: Event): void {
    const field = messageRef.current;
    if (!field) return;
    e.preventDefault();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }

  // On the dialog rather than the form, so the shortcut works from any field in
  // it, and the lint rule against key handlers on a plain `<form>` holds.
  function onDialogKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    // An input method mid-composition uses Enter to commit the candidate; that
    // keystroke is not the person asking to send.
    if (e.nativeEvent.isComposing) return;
    // The preview is portalled, but its key events still bubble up the React
    // tree to here; a shortcut pressed while reading it is not a send.
    if (previewOpen) return;
    e.preventDefault();
    void submit();
  }

  // The whole dialog takes the paste and the drop — a picture aimed anywhere on
  // it is a picture meant for it, and the drop target being one small box is the
  // usual reason a drag "does nothing".
  const captureHandlers = showScreenshot ? screenshot.handlers : undefined;

  // Stepping aside, not closing: `open` — the prop the form's reset watches — is
  // untouched, so the message, the chips and the email are all still there when
  // the picker hands control back. Only what is on screen changes.
  const isPointing = pointPhase !== null;

  const elementName = element ? pointedName : null;
  const caption = elementCaption(elementName);
  // The picture pointing produced, while it is still the one attached. A capture
  // or a paste afterwards replaces it, and then the element keeps its name but
  // no longer has a picture of its own.
  const elementHasShot = Boolean(element && elementShot && screenshot.dataUrl === elementShot);
  const showScreenshotThumb = showScreenshot && Boolean(screenshot.dataUrl) && !elementHasShot;
  const needsWords = !hasWords && (Boolean(screenshot.dataUrl) || element !== null);

  return (
    <>
      {isPointing && (
        <PointAtElementOverlay
          phase={pointPhase}
          onSelect={(target) => void onPointSelect(target)}
          onCancel={() => setPointPhase(null)}
        />
      )}
      <ResponsiveDialog open={open && !isPointing} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent
          {...captureHandlers}
          onKeyDown={onDialogKeyDown}
          // Coming back from the picker, or opening at all, lands in the words,
          // not on the first kind pill. Centered dialog only, decided by the
          // dialog's own shape: on the phone drawer, focusing a text field pops
          // the keyboard over the form unasked.
          desktopProps={{ className: 'max-w-md', onOpenAutoFocus: focusMessage }}
          className={cn(
            // `!min-h-0` overrides ResponsiveDialogContent's own `min-h-[50vh]` so
            // this panel can shrink to fit under `max-h-[85vh]` — the same pairing
            // every other dialog with an inner scroll region uses (see
            // InstallConfirmationDialog). Without it, the panel refused to
            // shrink and the form below had nowhere to put its own scrollbar,
            // so a tall form pushed Send off the bottom of the screen with no way
            // to reach it (DOR-2076).
            'max-h-[85vh] !min-h-0',
            screenshot.isDraggingOver && 'ring-primary ring-2'
          )}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">
              Send feedback
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Straight to the DorkOS team. Private.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          {/* `min-h-0` lets the form shrink below its content's natural height so
              its ResponsiveDialogBody child can become the one scrolling region —
              the footer below stays outside that region so Send is reachable at
              any viewport height. `noValidate`: an email field that does not
              look like one is said so in words beside it, never by a browser
              bubble that blocks the report. */}
          <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col gap-4">
            {/* `alignWithHeader`: the fields line up with the title on the
                centered dialog without shaving the focus ring's room
                (DOR-2076), and the drawer is left alone. */}
            <ResponsiveDialogBody alignWithHeader className="flex flex-col gap-4">
              <KindPills kind={kind} onChange={onKindChange} />

              {/* The message box, with its attachments and tools inside its border. */}
              <div
                className={cn(
                  'dark:bg-input/30 flex flex-col rounded-lg border transition-[border-color,box-shadow] duration-150',
                  'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
                  screenshot.isDraggingOver && 'border-primary'
                )}
              >
                <Label htmlFor={messageId} className="sr-only">
                  Your message
                </Label>
                <Textarea
                  ref={messageRef}
                  id={messageId}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={element ? placeholderForElement(elementName) : PLACEHOLDER[kind]}
                  rows={4}
                  maxLength={MAX_FEEDBACK_MESSAGE_LEN}
                  className="min-h-24 resize-none rounded-lg border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                />

                {(element ||
                  showScreenshotThumb ||
                  screenshot.isPreparing ||
                  screenshot.isDraggingOver) && (
                  <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5">
                    {element && (
                      <AttachmentThumbnail
                        imageUrl={elementHasShot ? (elementShot ?? undefined) : undefined}
                        alt={`The part you pointed at: ${caption}`}
                        caption={caption}
                        pointed
                        detail={element.selector}
                        {...(elementHasShot ? { onOpen: () => openPreview('screenshot') } : {})}
                        onRemove={removeElement}
                        removeLabel={removeElementLabel(elementName)}
                      />
                    )}
                    {showScreenshotThumb && screenshot.dataUrl && (
                      <AttachmentThumbnail
                        imageUrl={screenshot.dataUrl}
                        alt="The screenshot you attached"
                        onOpen={() => openPreview('screenshot')}
                        onRemove={screenshot.clear}
                        removeLabel="Remove screenshot"
                      />
                    )}
                    {(screenshot.isPreparing || screenshot.isDraggingOver) && (
                      <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
                        {screenshot.isDraggingOver ? 'Drop to attach' : 'Getting it ready…'}
                      </p>
                    )}
                  </div>
                )}

                <ComposerToolbar
                  showPictureTools={showScreenshot}
                  isPreparing={screenshot.isPreparing}
                  hasPointed={element !== null}
                  hasWords={hasWords}
                  isMobile={!isDesktop}
                  onCapture={() => void screenshot.capture()}
                  onPointAtElement={() => setPointPhase('picking')}
                  onPick={(file) => void screenshot.attach(file)}
                />
              </div>

              {/* Also send */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground mr-0.5 text-xs">Also send</span>
                <AlsoSendChip
                  label="Diagnostics"
                  summary="Version, window size, browser, and recent errors."
                  pressed={includeDiagnostics}
                  onPressedChange={(next) => {
                    setAttachmentsTouched(true);
                    setIncludeDiagnostics(next);
                  }}
                  onPreview={() => openPreview('diagnostics')}
                />
                {showConversation && (
                  <AlsoSendChip
                    label="This conversation"
                    summary="So we can see what led to the bug."
                    pressed={includeConversation}
                    onPressedChange={(next) => {
                      setAttachmentsTouched(true);
                      setIncludeConversation(next);
                    }}
                    onPreview={() => openPreview('conversation')}
                  />
                )}
              </div>

              <ReplyToField
                currentUser={currentUser ?? null}
                anonymous={anonymous}
                onToggleAnonymous={() => setAnonymous((a) => !a)}
                contact={contact}
                onContactChange={setContact}
              />
            </ResponsiveDialogBody>

            <FeedbackFormFooter
              needsWords={needsWords}
              canSend={canSend}
              isSubmitting={isSubmitting}
              onOpenGitHubIssue={() => reportIssue(kind === 'idea' ? 'feature' : 'bug')}
            />
          </form>

          <FeedbackPreviewDialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            initialTab={previewTab}
            diagnostics={buildDiagnostics(
              draftCrashStack ? { crashStack: draftCrashStack } : undefined
            )}
            kind={kind}
            route={route}
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
