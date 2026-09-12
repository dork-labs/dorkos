import {
  Globe,
  FileText,
  Braces,
  Image,
  File,
  FileCode,
  Box,
  FileAudio,
  FileVideo,
  Table,
  LayoutDashboard,
  AppWindow,
  GitCompare,
  Pin,
  PinOff,
  X,
} from 'lucide-react';
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { cn, hashToHslColor, initialOf, type CanvasView } from '@/layers/shared/lib';
import { IdentityAvatar, useRovingTabList } from '@/layers/shared/ui';

const CONTENT_TYPE_ICONS = {
  url: Globe,
  markdown: FileText,
  json: Braces,
  image: Image,
  pdf: File,
  widget: LayoutDashboard,
  mcp_app: AppWindow,
  file: FileCode,
  model3d: Box,
  audio: FileAudio,
  video: FileVideo,
  csv: Table,
  browser: Globe,
  diff: GitCompare,
} as const satisfies Record<UiCanvasContent['type'], unknown>;

/**
 * Invisible reach that grows the tab close button below `md`, vertically only.
 *
 * **`after:inset-x-0` is required, not decorative.** An absolutely positioned
 * empty pseudo-element with only `top`/`bottom` set shrink-wraps to 0px wide —
 * it catches nothing. Pinning `left`/`right` to the button's own edges (`0`,
 * not a negative inset) gives the `::after` the button's 24px width without
 * spending any of it: the box stays exactly as wide as the close button.
 *
 * **No horizontal GROWTH beyond that, on purpose.** The close button already
 * sits inside `pr-7` — 28px the tab button reserves for it — and at `p-1.5`
 * (below `md`) its 24px box fills that reservation edge to edge (`right-1`
 * plus 24px of box is 28px). Reaching sideways from there would spend the
 * tab's OWN clickable label area, so a tap meant to select the tab would
 * close it instead — worse than the small target this replaces. The tab grew
 * to `py-3` below `md` specifically to give the vertical reach somewhere safe
 * to go: an 8px vertical slack opens on each side of the now-centered 24px
 * box, bounded by the row itself, so `-inset-y-2` cannot spill onto anything
 * outside this tab.
 */
const TAB_CLOSE_TOUCH_REACH = 'after:absolute after:inset-x-0 after:-inset-y-2 md:after:hidden';

/**
 * DOM id of the content region a view's active tab controls.
 *
 * One per view, because the Canvas and Browser tabs render the same body over
 * different documents and an `aria-controls` that resolves to the other tab's
 * region is worse than none.
 *
 * @param view - Which of the right panel's two document views is rendering.
 * @returns The region's DOM id.
 */
export function canvasPanelId(view: CanvasView): string {
  return view === 'browser' ? 'browser-panel' : 'canvas-panel';
}

/** What a screen reader calls each view's document strip. */
const TABLIST_LABELS: Record<CanvasView, string> = {
  canvas: 'Open canvas documents',
  browser: 'Open browser pages',
};

/** Stable DOM id for a canvas document's tab — links panel `aria-labelledby` to it. */
export function canvasTabDomId(documentId: string): string {
  return `canvas-tab-${documentId}`;
}

/**
 * Who put a document on a shared table, as the tab needs to draw them.
 *
 * Faces come through the identity kit rather than from a raw `icon`/`color`
 * read: almost no agent stores either, so a call site that read them straight
 * would draw a blank disc for nearly every agent in the room.
 */
export interface CanvasDocumentAuthor {
  /** The author's id — what the face's fallback colour is hashed from. */
  id: string;
  /** Their name, for the face's letter and the tab's title. */
  displayName: string;
  /** Person, agent, or the room's own voice — decides the disc's shape and badge. */
  kind: AuthorKind;
  /** Their emoji, when they have one. */
  emoji?: string;
  /** Their own colour, when they have one. */
  color?: string;
  /** Their photo, when they have one. */
  imageUrl?: string;
}

/** A single open document, as the header needs to render its tab. */
export interface CanvasHeaderDocument {
  id: string;
  sourceLabel: string;
  contentType: UiCanvasContent['type'];
  /**
   * Who put it here. Set on a room's shared table, where the answer is
   * information; absent on a private session canvas, where it is always you.
   */
  author?: CanvasDocumentAuthor;
  /** Pinned documents sort first and are never dropped to make room. */
  pinned?: boolean;
  /** True when this document arrived and this viewer has not looked at it yet. */
  unread?: boolean;
  /**
   * Who else is looking at this document right now, never including the reader.
   *
   * Live and ephemeral: it is whatever the room's stream has said since this
   * browser connected, so it is empty far more often than it is wrong. Absent on
   * a private session canvas, where the answer is always nobody.
   */
  watchers?: readonly CanvasDocumentAuthor[];
}

/** How many faces a tab draws before the rest become a number. */
const WATCHER_FACE_LIMIT = 3;

/**
 * What a screen reader hears about who else is on a tab.
 *
 * Names, not a count, up to the point where a list stops being useful — "Ana is
 * looking at this" tells you something a bare "2 people" does not.
 *
 * @param watchers - The people and agents looking at this document.
 * @returns One sentence, or null when nobody else is here.
 */
function watchingSentence(watchers: readonly CanvasDocumentAuthor[]): string | null {
  const names = watchers.map((w) => w.displayName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is looking at this.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are looking at this.`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'} are looking at this.`;
}

/**
 * The stack of small faces a tab draws for the people looking at it.
 *
 * Its own component so the sentence and the discs stay together: the faces are
 * `aria-hidden` and the sentence is what a screen reader gets, and splitting
 * those apart is how one of them ends up drifting from the other.
 */
function CanvasTabWatchers({ watchers }: { watchers: readonly CanvasDocumentAuthor[] }) {
  const sentence = watchingSentence(watchers);
  if (sentence === null) return null;
  const shown = watchers.slice(0, WATCHER_FACE_LIMIT);
  const extra = watchers.length - shown.length;
  return (
    <>
      <span data-slot="canvas-tab-watchers" aria-hidden className="flex shrink-0 -space-x-1">
        {shown.map((watcher) => (
          <IdentityAvatar
            key={watcher.id}
            size="xs"
            // A ring in the strip's own background colour is what keeps two
            // overlapping discs readable as two faces rather than one blob.
            className="ring-background size-3.5 text-[8px] ring-1"
            kind={watcher.kind}
            color={watcher.color ?? hashToHslColor(watcher.id)}
            emoji={watcher.emoji}
            imageUrl={watcher.imageUrl}
            badge={null}
            fallback={initialOf(watcher.displayName)}
          />
        ))}
        {extra > 0 && (
          <span className="bg-muted text-muted-foreground ring-background flex size-3.5 shrink-0 items-center justify-center rounded-full text-[8px] ring-1">
            +{extra}
          </span>
        )}
      </span>
      <span className="sr-only">{sentence}</span>
    </>
  );
}

interface CanvasHeaderProps {
  /** Which view's strip this is — decides the panel id and the strip's name. */
  view: CanvasView;
  /** Open documents of that view, in tab order. Empty renders just the shared panel header (splash). */
  documents: CanvasHeaderDocument[];
  /** Id of the active document. */
  activeDocumentId: string | null;
  /** Activate a document by id. */
  onActivate: (id: string) => void;
  /** Close a document by id. */
  onClose: (id: string) => void;
  /**
   * Pin or unpin a document by id. Omitted where pinning means nothing — a
   * private canvas has no order worth defending — and the control is not drawn.
   */
  onPin?: (id: string, pinned: boolean) => void;
}

/**
 * Canvas document-tab strip — the Canvas panel's own content chrome, rendered
 * below the container-owned shared header. Each tab shows the document's
 * content-type icon, its label, and a close button; the active tab is
 * highlighted. Renders nothing when no documents are open (the splash state).
 *
 * Keyboard-accessible per the WAI-ARIA Tabs pattern (roving tabindex + arrow
 * navigation via {@link useRovingTabList}): one Tab stop per strip, arrow keys
 * move and activate, and Delete closes the focused tab. The close control is a
 * non-tab-stop sibling of the tab (mouse/touch only) so the DOM stays valid.
 */
export function CanvasHeader({
  view,
  documents,
  activeDocumentId,
  onActivate,
  onClose,
  onPin,
}: CanvasHeaderProps) {
  const panelId = canvasPanelId(view);
  const { getTabProps } = useRovingTabList({
    orderedIds: documents.map((doc) => doc.id),
    activeId: activeDocumentId,
    // Source is irrelevant here (no content auto-focus) — drop it so the
    // callers' single-argument contracts stay honest.
    onActivate: (id) => onActivate(id),
    onClose: (id) => onClose(id),
    // Delete on the last document: focus the (always-mounted, tabIndex=-1)
    // canvas content container — it shows the splash next — never the body.
    getFallbackFocus: () => document.getElementById(panelId),
  });

  if (documents.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={TABLIST_LABELS[view]}
      className="flex items-stretch gap-1 overflow-x-auto border-b px-2 py-1"
    >
      {documents.map((doc) => {
        const Icon = CONTENT_TYPE_ICONS[doc.contentType];
        const isActive = doc.id === activeDocumentId;
        const author = doc.author;
        return (
          // role="presentation" wrapper: ARIA expects tabs as direct tablist
          // children; this div exists only to anchor the absolutely-positioned
          // close control as a SIBLING of the tab (a button inside a button is
          // invalid HTML) — the same compromise VS Code ships.
          <div key={doc.id} role="presentation" className="group relative flex shrink-0">
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              id={canvasTabDomId(doc.id)}
              aria-controls={isActive ? panelId : undefined}
              {...getTabProps(doc.id)}
              className={cn(
                'focus-ring flex items-center gap-1.5 rounded-md py-3 pl-2 text-xs transition-colors md:py-1',
                // A pin control needs its own slot beside the close button, so
                // the tab reserves a second one — and only where pinning is
                // offered, so a private canvas's tabs keep their label width.
                onPin ? 'pr-12' : 'pr-7',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {author && (
                // Who put it here — the fact a shared table has and a private
                // canvas does not. Decorative: the tab's own title names them.
                <IdentityAvatar
                  aria-hidden
                  size="xs"
                  className="size-3.5 shrink-0 text-[8px]"
                  kind={author.kind}
                  color={author.color ?? hashToHslColor(author.id)}
                  emoji={author.emoji}
                  imageUrl={author.imageUrl}
                  badge={null}
                  fallback={initialOf(author.displayName)}
                />
              )}
              <Icon className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate font-medium">{doc.sourceLabel}</span>
              {doc.watchers && doc.watchers.length > 0 && (
                <CanvasTabWatchers watchers={doc.watchers} />
              )}
              {doc.unread && (
                <span
                  data-slot="canvas-tab-unread"
                  aria-hidden
                  className="bg-primary size-1.5 shrink-0 rounded-full"
                />
              )}
            </button>
            {onPin && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onPin(doc.id, !doc.pinned)}
                aria-label={doc.pinned ? `Unpin ${doc.sourceLabel}` : `Pin ${doc.sourceLabel}`}
                className={cn(
                  'focus-ring hover:bg-background/80 absolute top-1/2 right-6 -translate-y-1/2 rounded-sm p-1.5 transition-opacity md:p-0.5',
                  // A pin is state, so it stays visible; an unpinned tab's
                  // control is an affordance, so it waits for a hover.
                  doc.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
                )}
              >
                {doc.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onClose(doc.id)}
              aria-label={`Close ${doc.sourceLabel}`}
              className={cn(
                'focus-ring hover:bg-background/80 absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-1.5 opacity-60 transition-opacity group-hover:opacity-100 md:p-0.5',
                TAB_CLOSE_TOUCH_REACH
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
