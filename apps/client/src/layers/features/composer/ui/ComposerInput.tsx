import {
  useRef,
  useCallback,
  useState,
  useEffect,
  forwardRef,
  useImperativeHandle,
  lazy,
  Suspense,
} from 'react';
import { motion } from 'motion/react';
import { X, Paperclip } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsTouchOnly } from '@/layers/shared/model';
import { useInputKeyboard } from './use-input-keyboard';
import { INERT_SURFACE } from './editing-surface';
import type { EditingSurface } from './editing-surface';
import { TextareaField } from './field/TextareaField';
import type { ComposerFieldHandle, ComposerFieldProps } from './field/ComposerFieldProps';

/**
 * The rich-text field, in its own chunk.
 *
 * Reached only through this `lazy`, which is what keeps every Lexical byte out
 * of the entry chunk when the flag is off.
 */
const LexicalField = lazy(() => import('./field/LexicalField'));
import { InputActionButton } from './InputActionButton';

export interface ComposerInputHandle {
  focus: () => void;
  /**
   * Focus unless touch is the only pointer, where an unbidden focus pops the
   * software keyboard and scrolls the view.
   *
   * The rule lives HERE rather than at each call site: the composer's own
   * mount-time autofocus has always been guarded, but every host that focused
   * the composer through the handle — on session switch, on `?prompt=` seeding
   * — re-opened the same hole one caller at a time. Use this for any focus the
   * person did not just ask for; use {@link ComposerInputHandle.focus} for the ones
   * they did (tapping a queued row, picking a suggestion).
   *
   * Gated on the pointer, not the viewport width, for the same reason the Enter
   * rule is: a desktop window dragged under 768px has no software keyboard to
   * pop, and used to lose its focus-on-session-switch for no reason.
   */
  focusUnlessTouch: () => void;
  focusAt: (pos: number) => void;
}

/**
 * Every prop the composer's text field accepts.
 *
 * Exported because the `Composer` namespace object in the barrel infers its
 * type from this component; it is NOT part of the slice's public surface —
 * consumers pass props at the JSX site, they never name this type.
 */
export interface ComposerInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Agent is streaming a response. */
  isStreaming: boolean;
  /** File upload is in progress. */
  isUploading?: boolean;
  /**
   * Stop the upload that is in flight. When given, the composer's progress
   * control becomes a cancel control and Escape ends the upload — the same way
   * Escape stops a streaming turn. Omit only in hosts where an upload genuinely
   * cannot be stopped; the spinner then stays inert.
   */
  onCancelUpload?: () => void;
  /**
   * A dispatched native command (`/compact`, `/rename`) has not settled yet.
   * The composer keeps its text across that window on purpose, so this is what
   * stops a second Enter from turning one intent into two triggers.
   */
  commandPending?: boolean;
  /** Currently editing a queued message item. */
  editingQueueItem?: boolean;
  /**
   * 1-based position of the queue item under edit, when one is. Names *which*
   * message is being rewritten — the composer is the only place that can say so
   * while the queue panel is scrolled away or the row is off screen.
   */
  editingPosition?: number;
  /** Number of items currently in the message queue (for badge display). */
  queueDepth?: number;
  onStop?: () => void;
  /** Queue the current input for sending after streaming completes. */
  onQueue?: () => void;
  /**
   * Send the current input into the running task now (steer). Passed ONLY when
   * the agent can take a message mid-task — so the Steer choice, and its
   * keyboard shortcut, exist exactly when the runtime can honour them and are
   * absent (never greyed) otherwise. Only reachable while the agent is working.
   */
  onSteer?: () => void;
  /**
   * Add the current input as context the agent uses next, without cutting into
   * the running task (stage). Passed ONLY when the agent can take added
   * context. Same "present only when honoured" rule as {@link onSteer}.
   */
  onStage?: () => void;
  /** Save the queue item currently being edited. */
  onSaveEdit?: () => void;
  /** Cancel editing the current queue item and restore draft. */
  onCancelEdit?: () => void;
  onEscape?: () => void;
  /**
   * Clear the composer. When omitted the clear BUTTON is not rendered at all —
   * a visible X wired to nothing is a control that lies. The Escape-Escape
   * wipe still works either way: it edits this component's own textarea, and
   * the host's `onChange` carries the empty value out, so a composer with no
   * `onClear` is not a composer you cannot clear.
   */
  onClear?: () => void;
  isPaletteOpen?: boolean;
  /**
   * Whether the open palette has at least one row. Enter only belongs to the
   * palette when there is something to pick; on "No commands found." it falls
   * through and sends. Defaults to `false`.
   */
  paletteHasResults?: boolean;
  /**
   * Whether Tab picks the highlighted palette row alongside Enter. Defaults to
   * `true`, which is right for a palette the person asked for by typing `/` or
   * `@`. A host whose palette opens on its own — the home composer's "Jump back
   * in" panel, which floats up when the caret lands in an empty box — passes
   * `false`, so tabbing on moves focus instead of opening whatever was lit.
   */
  tabPicks?: boolean;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onCommandSelect?: () => void;
  activeDescendantId?: string;
  /**
   * `id` of the listbox the open palette actually rendered, or `undefined` when
   * no palette is open. Must come from whatever decided which palette to draw:
   * inferring it from `activeDescendantId` pointed at nothing whenever the open
   * palette had zero matches, because there is no active option to infer from.
   */
  paletteListboxId?: string;
  onCursorChange?: (pos: number) => void;
  /** Callback when files are selected via the paperclip button. */
  onAttach?: (files: File[]) => void;
  /** Custom placeholder text for the textarea. Defaults to "Send a message...". */
  placeholder?: string;
  /** Overlay element rendered in place of the native placeholder (e.g. animated hints). */
  placeholderOverlay?: React.ReactNode;
  /** Navigate up through the message queue (shell-history style). */
  onQueueNavigateUp?: () => void;
  /** Navigate down through the message queue (shell-history style). */
  onQueueNavigateDown?: () => void;
  /** Whether the queue has items (enables arrow key navigation). */
  queueHasItems?: boolean;
  /**
   * Whether the message can be sent. When `false`, BOTH submit paths are
   * disabled — the send button reads disabled and the Enter key does not submit
   * — while the input stays typeable. Used when the send target is not ready yet
   * (e.g. the default agent's path has not resolved from the registry). Defaults
   * to `true`. Streaming still queues and queue-item edits still save; this gates
   * only the send action.
   */
  canSubmit?: boolean;
  /**
   * Why the message cannot be sent yet, in one plain line, shown above the box
   * while `canSubmit` is false. Without it a greyed Send and an inert Enter are
   * the only feedback — someone typing their first sentence into DorkOS presses
   * Enter and nothing happens, with nothing on screen to explain it. Omit only
   * when another surface already states the reason.
   */
  canSubmitReason?: string;
  /**
   * Identifies the draft this composer holds — the session/cwd pair for the chat
   * composer, omitted by hosts that have neither. Only the pending
   * double-Escape reads it, to drop an arm raised against a draft that is no
   * longer on screen.
   */
  contextKey?: string;
  /**
   * Raised while a second Escape would wipe the draft, lowered when it would
   * not. This component owns WHEN — it owns the keyboard — but not WHERE: the
   * readout has to float clear of the queue panel and the attachment chips,
   * which sit above this component and are the host's to position against.
   * Measured: anchored inside this component it lands squarely on the bottom
   * queue row's Send-now and Remove buttons.
   *
   * Already folded with the reachability of the labelled Clear button, so a
   * host cannot accidentally advertise the shortcut where that button is
   * missing or disabled — see {@link ComposerInputProps.onClear}.
   */
  onClearArmedChange?: (armed: boolean) => void;
  /**
   * Handles this composer may draw as identity pills. Purely presentational —
   * the server still resolves who a mention addresses. Omitted by surfaces with
   * no roster.
   */
  mentionSubjects?: ComposerFieldProps['mentionSubjects'];
  /**
   * Show formatting as you type — bold, headings and lists take shape in the
   * box instead of staying as markdown characters.
   *
   * Additive and optional, so every existing call site compiles untouched and
   * never reads it. Off means the plain field, byte for byte what shipped.
   */
  richText?: boolean;
}

/**
 * The composer's text field — the part every surface actually types into.
 *
 * Owns the card's contents, the send/stop/queue action button, and the whole
 * keyboard ladder: Enter and Shift+Enter by device, the double-Escape clear and
 * its 500ms arming window, palette fall-through, queue navigation, and upload
 * cancel. That ladder lives in `use-input-keyboard.ts`, and its tests are its
 * only regression net — read them before changing a key.
 *
 * The field itself — the element holding the caret and its growth — is
 * `field/TextareaField`. The ladder never touches it: the field hands up an
 * `EditingSurface` and the ladder asks that seven questions, which is what lets
 * a different kind of field slot in without the keyboard rules moving.
 *
 * Deliberately controlled and deliberately ignorant of its surroundings. It
 * takes `value`/`onChange` and reports intent through callbacks; it does not
 * know what a session is, whether a palette has results, or what happens to a
 * submitted message. Everything above and around it — the card, the overlay
 * lane, attachment chips — is the host's to compose from the other parts of
 * this slice.
 *
 * Anything optional is genuinely optional: a host that passes no `onClear`
 * gets no clear button and no armed-clear signal at all, rather than a
 * half-opacity control wired to nothing.
 */
export const ComposerInput = forwardRef<ComposerInputHandle, ComposerInputProps>(
  function ComposerInput(
    {
      value,
      onChange,
      onSubmit,
      isStreaming,
      isUploading = false,
      onCancelUpload,
      commandPending = false,
      editingQueueItem = false,
      editingPosition,
      queueDepth = 0,
      onStop,
      onQueue,
      onSteer,
      onStage,
      onSaveEdit,
      onCancelEdit,
      onEscape,
      onClear,
      isPaletteOpen,
      paletteHasResults,
      tabPicks,
      onArrowUp,
      onArrowDown,
      onCommandSelect,
      activeDescendantId,
      paletteListboxId,
      onCursorChange,
      onAttach,
      placeholder = 'Send a message...',
      placeholderOverlay,
      onQueueNavigateUp,
      onQueueNavigateDown,
      contextKey,
      onClearArmedChange,
      queueHasItems = false,
      canSubmit = true,
      canSubmitReason,
      richText = false,
      mentionSubjects,
    },
    ref
  ) {
    const fieldRef = useRef<ComposerFieldHandle>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isFocused, setIsFocused] = useState(false);
    // The field reports its editing surface once it has one; until then the
    // ladder talks to the inert one, which answers exactly as it did when there
    // was no textarea in the ref yet.
    const [surface, setSurface] = useState<EditingSurface>(INERT_SURFACE);
    // One signal for both questions this component asks about the device, because
    // they are the same question: is there a software keyboard here? Enter's
    // meaning and whether an unbidden focus is welcome both follow from it, and
    // neither follows from viewport width.
    const isTouchOnly = useIsTouchOnly();

    useImperativeHandle(ref, () => ({
      focus: () => fieldRef.current?.focus(),
      focusUnlessTouch: () => fieldRef.current?.focusUnlessTouch(),
      focusAt: (pos: number) => fieldRef.current?.focusAt(pos),
    }));

    // Auto-focus on mount (e.g. returning from interactive tool-approval mode),
    // except on a touch-only device, where it pops the software keyboard and
    // scrolls the view every time a session opens. Read through a ref snapshot so
    // a later device change can never steal focus mid-session.
    const isTouchOnlyOnMountRef = useRef(isTouchOnly);
    useEffect(() => {
      if (isTouchOnlyOnMountRef.current) return;
      fieldRef.current?.focus();
    }, []);

    const { handleKeyDown, clearArmed } = useInputKeyboard({
      surface,
      value,
      isStreaming,
      isTouchOnly,
      isUploading,
      onCancelUpload,
      commandPending,
      canSubmit,
      editingQueueItem,
      isPaletteOpen,
      paletteHasResults,
      tabPicks,
      queueHasItems,
      onSubmit,
      onStop,
      onEscape,
      onClear,
      onArrowUp,
      onArrowDown,
      onCommandSelect,
      onQueue,
      onSteer,
      onStage,
      onSaveEdit,
      onCancelEdit,
      onQueueNavigateUp,
      onQueueNavigateDown,
      contextKey,
    });

    const handleFocus = useCallback(() => setIsFocused(true), []);
    const handleBlur = useCallback(() => {
      setIsFocused(false);
      if (isPaletteOpen) onEscape?.();
    }, [isPaletteOpen, onEscape]);

    // One narrowed object, so both fields are given exactly the same props and
    // the swap cannot drift.
    const fieldProps: ComposerFieldProps & { ref: typeof fieldRef } = {
      ref: fieldRef,
      value,
      onChange,
      onCursorChange,
      onKeyDown: handleKeyDown,
      onFocus: handleFocus,
      onBlur: handleBlur,
      placeholder,
      placeholderOverlay,
      isPaletteOpen,
      paletteHasResults,
      paletteListboxId,
      activeDescendantId,
      onSurfaceChange: setSurface,
      mentionSubjects,
    };

    const hasText = value.trim().length > 0;
    // Whether the labelled "Clear message" button is on screen AND usable: a host
    // has to wire `onClear` for it to render at all, and there has to be text to
    // clear. This gates the armed readout below, because that readout is
    // deliberately hidden from assistive tech — showing it anywhere the button is
    // unreachable would advertise a destructive keyboard shortcut to sighted
    // people and to nobody else.
    const clearReachable = onClear !== undefined && hasText;

    useEffect(() => {
      onClearArmedChange?.(clearArmed && clearReachable);
    }, [clearArmed, clearReachable, onClearArmedChange]);

    return (
      <div className="flex flex-col gap-1.5">
        {/* A live region, not a plain line: the failure it explains is "I pressed
          Enter and nothing happened", which a screen-reader user gets no other
          signal for at all. */}
        {!canSubmit && canSubmitReason && (
          <div role="status" className="text-muted-foreground px-1 text-xs">
            {canSubmitReason}
          </div>
        )}
        {editingQueueItem && (
          <div className="text-muted-foreground px-0.5 text-xs">
            {editingPosition !== undefined && queueDepth > 0
              ? `Editing message ${editingPosition} of ${queueDepth}`
              : 'Editing message'}
          </div>
        )}
        <div
          className={cn(
            'border-input bg-background flex items-end gap-1.5 rounded-md border p-1.5 shadow-xs transition-[color,box-shadow]',
            isFocused && 'border-ring ring-ring/75 ring-[1px]',
            editingQueueItem && 'border-primary/40',
            !onAttach && 'pl-3'
          )}
        >
          {onAttach && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) onAttach(files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="focus-ring text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 transition-colors disabled:opacity-50"
                aria-label="Attach file"
              >
                <Paperclip className="size-4" />
              </button>
            </>
          )}
          {richText ? (
            // The fallback is the TEXTAREA, not a spinner: a composer that is
            // briefly un-typeable is worse than one that is briefly plain, and
            // the two share `value`/`onChange`, so nothing is lost when the
            // chunk arrives.
            <Suspense fallback={<TextareaField {...fieldProps} />}>
              <LexicalField {...fieldProps} />
            </Suspense>
          ) : (
            <TextareaField {...fieldProps} />
          )}
          {/* Only rendered when there is something to clear TO. Hosts that pass no
            `onClear` (the dashboard and onboarding composers) used to show this
            X at half opacity, enabled and tab-reachable, wired to nothing. */}
          {onClear && (
            <motion.button
              animate={{ opacity: hasText ? 0.5 : 0, scale: hasText ? 1 : 0.8 }}
              transition={{ duration: 0.15 }}
              whileHover={hasText ? { opacity: 1 } : undefined}
              onClick={onClear}
              disabled={!hasText}
              type="button"
              className={cn(
                'focus-ring text-muted-foreground hover:text-foreground shrink-0 rounded-lg p-1 transition-colors',
                !hasText && 'pointer-events-none'
              )}
              aria-label="Clear message"
            >
              <X className="size-(--size-icon-sm)" />
            </motion.button>
          )}
          <InputActionButton
            hasText={hasText}
            isStreaming={isStreaming}
            // Only ever an upload this composer can stop. A host that reports an
            // upload without a way to end it gets no progress control rather than
            // an inert one — the spinner nobody could press is the wedge itself.
            onCancelUpload={isUploading ? onCancelUpload : undefined}
            commandPending={commandPending}
            submitDisabled={!canSubmit}
            editingQueueItem={editingQueueItem}
            queueDepth={queueDepth}
            isTouchOnly={isTouchOnly}
            onSubmit={onSubmit}
            onStop={onStop}
            onQueue={onQueue}
            onSteer={onSteer}
            onStage={onStage}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
          />
        </div>
      </div>
    );
  }
);
