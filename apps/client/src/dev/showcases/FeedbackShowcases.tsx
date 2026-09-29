import { useState } from 'react';
import { Check, Copy, Crosshair, X } from 'lucide-react';
import { toast } from 'sonner';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Skeleton,
  Button,
  CopyButton,
  PermissionModeScopeNote,
  UnverifiedCatalogNotice,
} from '@/layers/shared/ui';
import { useCopyFeedback } from '@/layers/shared/lib';
import { FeedbackDialog } from '@/layers/features/feedback';

/**
 * A stand-in for an attached screenshot: a 200x120 PNG of an app window,
 * small enough to sit inline here. A real one comes out of `compressImage`
 * as WebP, but the dialog only ever renders whatever `data:` URL it is given.
 */
const SAMPLE_SCREENSHOT_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAA48Cq8AAABY0lEQVR42u3asQ3AIAxFQaagiCioKDIDZUSZ/cdhCZQYcdKbwLrOP7V2S8tLTiCwBJbAksASWAJLAktgCSwJLIElsCSwBJbAksBSYFil1C3K+dJGgSWwBBZYYIElsAQWWGCBJbAEFlhggSWwBNY3sMZ4tTywwAILLLDAAgssDsACCyywwAJLYIEFFlhggSWwwAILLLDAElhmM2YzYAksgQUWWGAJLIEFFlhgCSyBBRZYMWH1/hwbWGCBBRZYYIEFFlhggQUWWGCBBRZYYIEFFlhggQUWWGCBBRZYYIFlNiOwBBZYYIElsAQWWGCBJbAEFlhggSUvHf37/wELLLDAAgsssMACCyywwAILLLDAAgsssMACCyywwAILLLDAAgsssGQ2AxZYYAksgQUWWGAJLIEFFlhgCSyBBRZYYAksgQUWWGAJLIEFFlhgCSyBBRZYYAksgQUWWGAJLIEFFlhgCSwFaAL7shD3S2x8pAAAAABJRU5ErkJggg==';

/**
 * Breaks `navigator.clipboard.writeText` for exactly one call, so the
 * showcase can put `useCopyFeedback`'s failure state on screen without
 * relying on a browser permission that is rarely denied in practice.
 */
async function copyThatFails(copy: (text: string) => Promise<boolean>) {
  const clipboard = navigator.clipboard;
  const original = clipboard.writeText.bind(clipboard);
  clipboard.writeText = () => Promise.reject(new Error('denied'));
  try {
    await copy('this will fail');
  } finally {
    clipboard.writeText = original;
  }
}

/** The icon-button pair: a real copy next to a forced failure. */
function CopyButtonDemo() {
  const { copy } = useCopyFeedback();
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <CopyButton value="dorkos.ai" label="Copy site URL" />
        <span className="text-muted-foreground text-xs">Click to copy</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void copyThatFails(copy)}
          className="text-muted-foreground hover:text-foreground focus-ring rounded-sm p-1 transition-colors"
          aria-label="Copy (forced failure demo)"
        >
          <Copy className="size-3.5" />
        </button>
        <span className="text-muted-foreground text-xs">Click to force a failure</span>
      </div>
      {/* Three glyph sizes on the library's `xs · sm · md` scale. The button's
          own box does not change — it is always `icon-sm`, so the target stays
          the same however small the glyph gets. */}
      <div className="flex items-center gap-2">
        <CopyButton size="xs" value="dorkos.ai" label="Copy site URL (extra small)" />
        <CopyButton size="sm" value="dorkos.ai" label="Copy site URL (small)" />
        <CopyButton size="md" value="dorkos.ai" label="Copy site URL (medium)" />
        <span className="text-muted-foreground text-xs">xs · sm · md</span>
      </div>
    </div>
  );
}

/** The inline text-morph shape `ServerTab`'s copy rows use around the same hook. */
function CopyTextRowDemo() {
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      onClick={() => void copy('~/.dork/logs')}
      className="hover:bg-muted/50 flex w-56 items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors"
    >
      <span className="text-muted-foreground text-sm">Log location</span>
      {copied ? (
        <span className="text-xs">Copied</span>
      ) : failed ? (
        <span className="text-destructive text-xs">Couldn’t copy</span>
      ) : (
        <span className="font-mono text-xs">~/.dork/logs</span>
      )}
    </button>
  );
}

/** The row-glyph shape `ProfileRow` uses: the value stays put, only the trailing icon morphs. */
function CopyGlyphRowDemo() {
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      onClick={() => void copy('/Users/you/projects/dorkos')}
      className="hover:bg-muted/50 flex w-72 items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors"
    >
      <span className="text-muted-foreground text-sm">Folder</span>
      <span className="flex items-center gap-1.5">
        <span className="truncate font-mono text-xs">/Users/you/projects/dorkos</span>
        {copied ? (
          <Check className="text-status-success size-3.5 shrink-0" />
        ) : failed ? (
          <X className="text-status-error size-3.5 shrink-0" />
        ) : (
          <Copy className="text-muted-foreground/70 size-3.5 shrink-0" />
        )}
      </span>
    </button>
  );
}

/**
 * The toast fallback — `toastOnSettle: true` — for a control with no chrome
 * left to morph once it is clicked (a menu item that closes its menu).
 */
function CopyToastFallbackDemo() {
  const { copy } = useCopyFeedback({ toastOnSettle: true });
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void copy('@warden')}>
        Copy @handle
      </Button>
      <span className="text-muted-foreground text-xs">
        Menu item chrome — settles as one neutral toast instead
      </span>
    </div>
  );
}

/**
 * A still of the "Point at it" picker, mid-aim.
 *
 * A STILL and not the real thing, deliberately: the picker covers the whole
 * window and swallows every pointer event, so mounting a live one inside a
 * scrolling gallery of components would take the gallery over. What it is for is
 * the look — the scrim, the outline, the name pill, the hint bar — in both
 * themes, side by side with everything else. The live picker is one click away
 * in the dialog showcase above, and it really runs from there.
 */
function PointAtElementStill() {
  return (
    <div className="bg-muted/30 relative h-56 w-full overflow-hidden rounded-md border">
      {/* Stand-ins for the app underneath. */}
      <div className="flex h-full gap-3 p-3">
        <div className="bg-background/60 h-full w-28 rounded" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="bg-background/60 h-8 rounded" />
          <div className="bg-background/60 flex-1 rounded" />
        </div>
      </div>
      {/* The picker: everything dims except the one box, which carries the scrim
          as its own shadow — exactly how the real overlay draws it. */}
      <div
        className="border-primary absolute rounded-sm border-2"
        style={{
          left: 12,
          top: 52,
          width: 112,
          height: 40,
          boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.5)',
        }}
      />
      <div
        className="bg-primary text-primary-foreground absolute rounded-sm px-1.5 py-0.5 font-mono text-[11px] leading-tight"
        style={{ left: 12, top: 30 }}
      >
        sidebar-toggle
      </div>
      <div className="bg-popover text-popover-foreground absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-3 py-2 shadow-lg">
        <span className="flex items-center gap-2 text-xs">
          <Crosshair className="size-3.5 shrink-0" aria-hidden />
          Click the part that looks wrong. Esc to cancel.
        </span>
        <span className="text-muted-foreground text-xs underline underline-offset-2">Cancel</span>
      </div>
    </div>
  );
}

/** Application feedback, loading and notification examples. */
export function FeedbackShowcases() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackBugOpen, setFeedbackBugOpen] = useState(false);
  const [feedbackShotOpen, setFeedbackShotOpen] = useState(false);
  const [feedbackSignedOutOpen, setFeedbackSignedOutOpen] = useState(false);

  return (
    <>
      <PlaygroundSection
        title="Feedback dialog"
        description="Composer-style send dialog (DOR-2232): kind pills, one message box with the thumbnails and a toolbar (Capture app, Point at it, add an image) inside its border, 'Also send' chips with a preview eye, then who we reply to, then Send. Send stays off until there are words; with an attachment and no words the footer says why. The third button opens it with a screenshot already attached; the fourth opens it signed out, which swaps the 'Replying to' line for the 'Your email' field (remembered in this browser). Both capture paths really run here: 'Capture app' hides the dialog and photographs this page, and 'Point at it' hands you a crosshair, crops the picture to whatever you click, and comes back with the element as a captioned thumbnail and the message box asking about it. The draft survives closing: close one mid-report and reopen it."
      >
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setFeedbackOpen(true)}>
              Open (Feedback)
            </Button>
            <Button variant="outline" onClick={() => setFeedbackBugOpen(true)}>
              Open (Bug)
            </Button>
            <Button variant="outline" onClick={() => setFeedbackShotOpen(true)}>
              Open (screenshot attached)
            </Button>
            <Button variant="outline" onClick={() => setFeedbackSignedOutOpen(true)}>
              Open (signed out)
            </Button>
          </div>
          <FeedbackDialog
            open={feedbackOpen}
            onOpenChange={setFeedbackOpen}
            currentUser={{ email: 'you@example.com', name: 'You' }}
          />
          <FeedbackDialog
            open={feedbackBugOpen}
            onOpenChange={setFeedbackBugOpen}
            initialKind="bug"
            currentUser={{ email: 'you@example.com', name: 'You' }}
          />
          <FeedbackDialog
            open={feedbackShotOpen}
            onOpenChange={setFeedbackShotOpen}
            initialKind="bug"
            initialScreenshotDataUrl={SAMPLE_SCREENSHOT_DATA_URL}
            currentUser={{ email: 'you@example.com', name: 'You' }}
          />
          <FeedbackDialog
            open={feedbackSignedOutOpen}
            onOpenChange={setFeedbackSignedOutOpen}
            currentUser={null}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Point at it (still)"
        description="What the picker looks like mid-aim: the app dims, the thing under the pointer lights up with the name the codebase uses for it, and the bar says how to commit or get out. A still, not the live picker — a real one covers the whole window and swallows every click, which would take this page over. To drive the real one, open the feedback dialog above and press Point at it in the message box."
      >
        <ShowcaseDemo>
          <PointAtElementStill />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Skeleton" description="Loading placeholder with animated tasks.">
        <ShowcaseDemo>
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Copy feedback"
        description="The one copy-to-clipboard mechanism app-wide (useCopyFeedback + CopyButton): idle, copied (~1.2s, then reverts), or failed — inline in the control that was clicked, never a toast on top of it. The toast fallback is opt-in, for a control with no chrome left to morph once it closes."
      >
        <ShowcaseLabel>Icon button (idle / copied / failed)</ShowcaseLabel>
        <ShowcaseDemo>
          <CopyButtonDemo />
        </ShowcaseDemo>

        <ShowcaseLabel>Text morph — ServerTab copy rows</ShowcaseLabel>
        <ShowcaseDemo>
          <CopyTextRowDemo />
        </ShowcaseDemo>

        <ShowcaseLabel>Trailing glyph — ProfileRow</ShowcaseLabel>
        <ShowcaseDemo>
          <CopyGlyphRowDemo />
        </ShowcaseDemo>

        <ShowcaseLabel>Toast fallback — ProfileActionsMenu, AgentNode, entry-actions</ShowcaseLabel>
        <ShowcaseDemo>
          <CopyToastFallbackDemo />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Toaster" description="Toast notifications via Sonner.">
        <ShowcaseDemo>
          {/* Toasts render via the global <Toaster /> in App.tsx */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => toast.success('Agent deployed successfully')}>
              Success
            </Button>
            <Button variant="outline" onClick={() => toast.error('Failed to connect to runtime')}>
              Error
            </Button>
            <Button variant="outline" onClick={() => toast.info('Session sync in progress')}>
              Info
            </Button>
            <Button variant="outline" onClick={() => toast.warning('Rate limit approaching')}>
              Warning
            </Button>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PermissionModeScopeNote"
        description="What a mode that stops asking does NOT cover, said where the mode is chosen — DorkOS-level approvals still ask, whatever the session's own reach. Renders nothing for a mode that still asks."
      >
        <ShowcaseLabel>Default — still asks, so the note renders nothing</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="border-border/60 rounded-md border border-dashed p-3">
            <PermissionModeScopeNote mode="default" />
            <p className="text-muted-foreground text-xs italic">
              (nothing rendered above — the border is the demo’s)
            </p>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>A mode that never asks — the note appears</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionModeScopeNote mode="bypassPermissions" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="UnverifiedCatalogNotice"
        description="Says out loud that a model menu is a bounded guess, not the real list — shown whenever the runtime found no connected credentials."
      >
        <ShowcaseDemo>
          <UnverifiedCatalogNotice />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
