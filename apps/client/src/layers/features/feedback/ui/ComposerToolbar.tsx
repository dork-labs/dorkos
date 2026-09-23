import { useId, type ChangeEvent, type ReactNode } from 'react';
import { Camera, Crosshair, Paperclip } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { isMac } from '@/layers/shared/lib';

interface ComposerToolbarProps {
  /** Show the picture tools at all. Off under the in-process (Obsidian) transport, which cannot send a picture. */
  showPictureTools: boolean;
  /** True while an image is being captured, cropped or compressed. Holds the picture tools. */
  isPreparing: boolean;
  /** Whether an element has already been pointed at, which renames "Point at it" to "Point again". */
  hasPointed: boolean;
  /** Whether there are words in the message, which is when the send shortcut is worth mentioning. */
  hasWords: boolean;
  /**
   * Whether the viewport is below the mobile breakpoint (768px). Hides "Point at
   * it", which needs a pointer and room to aim, and the keyboard hint.
   */
  isMobile: boolean;
  /** Take a picture of the app itself and attach it. */
  onCapture: () => void;
  /** Step out of the dialog and let the person aim at one element. */
  onPointAtElement: () => void;
  /** Attach a file the person picked. */
  onPick: (file: File) => void;
}

/**
 * The capture buttons' look, held with `aria-disabled` rather than `disabled`
 * while a picture is being prepared. A natively disabled button that has focus
 * drops it to `<body>`, and the capture is exactly when that must not happen: a
 * paste in that moment would land outside the dialog (DOR-1956, and the
 * `feedback-capture-focus` browser spec).
 */
const HELD_BUTTON =
  'text-muted-foreground hover:text-foreground h-8 px-2 text-xs aria-disabled:pointer-events-none aria-disabled:opacity-50';

/** One toolbar control with its explanation in a tooltip rather than a paragraph under it. */
function WithTip({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-60 text-center">{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The row of tools along the bottom of the feedback message box.
 *
 * Everything that adds to a report lives here, inside the box, like a chat
 * composer: capture the app, point at the part that looks wrong, or pick an
 * image. What each one promises ("never the rest of your screen", "paste or drop
 * works anywhere on the form") is said once, in its tooltip, rather than as three
 * hint lines under the buttons (feedback-form-redesign §2). The same sentence is
 * each control's `aria-describedby` too, through a visually hidden copy: Radix
 * wires a tooltip's text up only while it is showing, and the image picker's
 * focusable element is the hidden input inside the label, not the trigger.
 *
 * "Point at it" is offered only on a wide viewport. `isMobile` is a 768px media
 * query, not a device check; a window narrow enough to trip it has no room to aim
 * in, so a narrow desktop window loses it too. Hidden rather than disabled, since
 * a control a surface is not offering is not one it should be showing.
 */
export function ComposerToolbar({
  showPictureTools,
  isPreparing,
  hasPointed,
  hasWords,
  isMobile,
  onCapture,
  onPointAtElement,
  onPick,
}: ComposerToolbarProps) {
  // Generated, not a module constant: the Dev Playground mounts three of these
  // dialogs at once, and a shared id would point every label at the first input.
  const fileInputId = useId();
  const captureTipId = useId();
  const pointTipId = useId();
  const pickTipId = useId();

  function onInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Clear the input so picking the SAME file twice in a row still fires a
    // change event (the second pick is otherwise a no-op).
    event.target.value = '';
    if (file) onPick(file);
  }

  const showShortcutHint = hasWords && !isMobile;
  // An empty strip with a rule above it reads as something failed to load.
  if (!showPictureTools && !showShortcutHint) return null;

  const pickLabel = isMobile ? 'Add a photo' : 'Add an image';
  const pickTip = isMobile
    ? 'Add a photo from your library.'
    : 'Add an image from your files. You can also paste or drop one anywhere on this form.';
  const captureTip = 'Take a picture of this app. Never the rest of your screen.';
  const pointTip = 'Click the part that looks wrong. We’ll crop the picture to it.';

  return (
    <div className="flex flex-wrap items-center gap-1 border-t px-1.5 py-1.5">
      {showPictureTools && (
        <>
          <span id={captureTipId} className="sr-only">
            {captureTip}
          </span>
          <WithTip tip={captureTip}>
            <Button
              aria-describedby={captureTipId}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!isPreparing) onCapture();
              }}
              aria-disabled={isPreparing || undefined}
              className={HELD_BUTTON}
            >
              <Camera className="size-3.5" aria-hidden />
              Capture app
            </Button>
          </WithTip>
          {!isMobile && (
            <WithTip tip={pointTip}>
              <Button
                aria-describedby={pointTipId}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (!isPreparing) onPointAtElement();
                }}
                aria-disabled={isPreparing || undefined}
                className={HELD_BUTTON}
              >
                <Crosshair className="size-3.5" aria-hidden />
                {hasPointed ? 'Point again' : 'Point at it'}
              </Button>
            </WithTip>
          )}
          {!isMobile && (
            <span id={pointTipId} className="sr-only">
              {pointTip}
            </span>
          )}
          <span id={pickTipId} className="sr-only">
            {pickTip}
          </span>
          <WithTip tip={pickTip}>
            {/* A label, so the whole button opens the picker and a keyboard reaches
                it through the input inside. The input is visually hidden, not
                `display: none`, which would take it out of the tab order. */}
            <label
              htmlFor={fileInputId}
              aria-disabled={isPreparing || undefined}
              className="text-muted-foreground hover:text-foreground hover:bg-accent focus-within:ring-ring flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 focus-within:ring-2 aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              <Paperclip className="size-3.5" aria-hidden />
              <input
                id={fileInputId}
                type="file"
                accept="image/*"
                aria-label={pickLabel}
                aria-describedby={pickTipId}
                disabled={isPreparing}
                className="sr-only"
                onChange={onInputChange}
              />
            </label>
          </WithTip>
        </>
      )}
      {showShortcutHint && (
        <span className="text-muted-foreground ml-auto pr-1.5 text-xs" aria-hidden>
          {isMac ? '⌘↵' : 'Ctrl+↵'} to send
        </span>
      )}
    </div>
  );
}
