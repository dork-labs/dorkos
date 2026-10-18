import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useFollowedView } from '@/layers/entities/room';
import type { BrowserHistoryState } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import { Input } from '@/layers/shared/ui';
import { cn, openExternalLink } from '@/layers/shared/lib';
import { useDevtoolsBridge } from '../model/use-devtools-bridge';
import { useDocFrameChannel } from '../model/use-doc-frame-channel';
import { roomCanvasRefusal, useRoomCanvasActions } from '../model/use-room-canvas';
import { useResolvedFrame } from '../model/use-resolved-frame';
import { BrowserBody } from './BrowserPreviewFrame';
import {
  classifyBrowserTarget,
  describeAddress,
  loopbackStrategy,
  normalizeAddressInput,
} from '../lib/browser-url';

/**
 * How long a frame may sit without firing `load` before the browser says so.
 *
 * Ten seconds is past every healthy first paint (a cold Vite start is a second
 * or two) and short of the patience of someone staring at a white rectangle. The
 * frame stays mounted underneath: this is a message, not a giving-up.
 */
interface CanvasBrowserContentProps {
  /**
   * The owning canvas document's id. Keys this browser's navigation history in
   * the app store so it survives the renderer remount a document-tab switch
   * forces (DOR-252).
   */
  documentId: string;
  /**
   * Browser or URL canvas content — both render here (DOR-233): every webpage
   * opened in the canvas gets navigation chrome and origin isolation. The two
   * variants differ only in the schema-level shape of `url`; the renderer reads
   * `url` and `title` and treats them identically.
   */
  content: Extract<UiCanvasContent, { type: 'browser' | 'url' }>;
}

/**
 * Seed the in-component navigation stack on mount from stored history (DOR-252).
 *
 * Restores a stored stack + cursor only when it belongs to the SAME
 * `content.url` — an agent-driven url change (`update_canvas` / reopen) leaves a
 * stale entry whose `contentUrl` no longer matches, so the browser reseeds fresh
 * from the new url. This reproduces the DOR-233 remount-resets-history semantic
 * for agent-driven changes while preserving history across plain tab switches
 * (same url, same document). Defensively clamps a stored cursor into bounds.
 */
function seedHistory(
  stored: BrowserHistoryState | undefined,
  contentUrl: string
): { stack: string[]; cursor: number } {
  if (stored && stored.contentUrl === contentUrl && stored.stack.length > 0) {
    const cursor = Math.min(Math.max(stored.cursor, 0), stored.stack.length - 1);
    return { stack: stored.stack, cursor };
  }
  return { stack: [contentUrl], cursor: 0 };
}

/**
 * Embedded browser canvas with navigation chrome (back/forward/reload/address
 * bar). Local files are routed through the signed serve route and rendered in an
 * opaque-origin sandbox (no `allow-same-origin`, ADR 260708-185519) so untrusted
 * content can never call `/api/*` as the user. External sites are framed
 * directly. A localhost dev server is framed on a preview origin DorkOS opens
 * for it, falling back to its own address — see `useResolvedFrame`.
 *
 * Honesty about embedding, in three parts:
 * - An external site's `X-Frame-Options` / `frame-ancestors` refusal cannot be
 *   reliably detected from the parent (a blocked frame still fires `load`
 *   cross-origin), so rather than guess, the browser always surfaces an "open in
 *   system browser" affordance for external pages.
 * - A dev server is checked before it is framed — by DorkOS AND by this browser
 *   — so a port with nothing on it, or an origin this device cannot reach, is a
 *   sentence rather than a white rectangle.
 * - A frame that never finishes loading, and a page whose own resources failed,
 *   both say so above the frame — which stays mounted, because a slow or partly
 *   broken page is still a page.
 */
export function CanvasBrowserContent({ documentId, content }: CanvasBrowserContentProps) {
  const cwd = useAppStore((s) => s.selectedCwd);
  const writeBrowserHistory = useAppStore((s) => s.writeBrowserHistory);

  // In-component navigation history: a stack of visited logical targets + a
  // cursor. The stack holds LOGICAL urls/paths (never the signed token URLs) so
  // the address bar can display them honestly and each navigation/reload re-mints
  // a fresh signed URL (tokens expire).
  //
  // Seeded from the store on mount (read non-reactively — this is a one-shot
  // hydration, not a subscription) so a document-tab switch restores its stack
  // instead of resetting to a single entry (DOR-252).
  const [seed] = useState(() =>
    seedHistory(useAppStore.getState().browserHistories[documentId], content.url)
  );
  const [history, setHistory] = useState<string[]>(seed.stack);
  const [cursor, setCursor] = useState(seed.cursor);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Write-through: mirror every nav into the store so a later remount (tab
  // switch) can restore it. Chosen over persist-on-unmount because an unmount-
  // only write loses state if the component crashes, and the write is tiny.
  // `content.url` is stable for this component's lifetime (the renderer keys on
  // it, so a url change remounts), so this fires only on real navigation.
  useEffect(() => {
    writeBrowserHistory(documentId, { contentUrl: content.url, stack: history, cursor });
  }, [documentId, content.url, history, cursor, writeBrowserHistory]);

  const currentUrl = history[cursor];
  const target = useMemo(() => classifyBrowserTarget(currentUrl), [currentUrl]);

  // Whether a loopback dev server can be framed by its own URL, which depends on
  // where this page is being viewed from — not on the target.
  const strategy = useMemo(
    () => (target.mode === 'proxy' ? loopbackStrategy(window.location.hostname) : null),
    [target]
  );

  // DevTools bridge seam (DOR-213): relay the preview's console + network to the
  // attached session. The shim talks only to this frame's parent (never
  // `/api/*`); this hook is that parent. Inert for external frames and for a
  // dev server framed by its own address (nothing injects the shim into either),
  // and when no session is attached.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { resolved, resolveError } = useResolvedFrame({
    target,
    currentUrl,
    strategy,
    cwd,
    reloadNonce,
  });
  const { resourceErrorCount, notePersonNavigated, noteFrameLoaded } = useDevtoolsBridge({
    iframeRef,
    documentId,
    logicalUrl: currentUrl,
    reloadNonce,
    previewOrigin: resolved?.previewOrigin ?? null,
    bridgeEligibility: resolved?.bridgeEligibility ?? null,
    resolvedSource: resolved?.src ?? null,
  });
  // The page's own `window.dorkos.channel`, connected to this document. Only
  // pages DorkOS serves carry it; everything else stays a plain page.
  const docFrame = useDocFrameChannel({
    iframeRef,
    documentId,
    logicalUrl: currentUrl,
    reloadNonce,
    previewOrigin: resolved?.previewOrigin ?? null,
    bridgeEligibility: resolved?.bridgeEligibility ?? null,
    resolvedSource: resolved?.src ?? null,
  });

  // Which room this browser is showing a page FOR, or null where the canvas is
  // this browser's own. Read from the store rather than the route: the room
  // stream writes it for exactly the room on screen, and this component renders
  // in shells and tests with no router behind them.
  const roomId = useAppStore((s) => s.roomCanvasLiveRoomId);
  const { open: openInRoom } = useRoomCanvasActions(roomId ?? '');
  /**
   * The address the room refused, and what it said — held so the typed URL
   * survives the failure.
   *
   * Losing what somebody just typed is the worst thing a text field can do, and
   * it is exactly what happened while this posted and forgot: the bar reverted
   * to the page already on screen and nothing said why. The bar reopens on this
   * value instead, so the fix is an edit rather than a retype.
   */
  const [refusedAddress, setRefusedAddress] = useState<{ url: string; message: string } | null>(
    null
  );

  const navigate = useCallback(
    (url: string) => {
      setHistory((h) => [...h.slice(0, cursor + 1), url]);
      setCursor((c) => c + 1);
    },
    [cursor]
  );

  // Where the person this viewer is following has their browser, and whether
  // this viewer is in the middle of typing in something.
  const followedView = useFollowedView(roomId);
  const editingDocumentId = useAppStore((s) =>
    roomId ? (s.roomCanvasEditing[roomId] ?? null) : null
  );

  // Go where they went (spec `canvas-agent-seat` §6). Only for THIS document —
  // the tab strip moves the viewer onto the right one — and never while this
  // viewer is editing something, which is room-canvas §9.3 and outranks
  // following: losing a draft is worse than losing the thread.
  useEffect(() => {
    if (followedView === null || editingDocumentId !== null) return;
    if (followedView.documentId !== documentId) return;
    const url = followedView.url;
    if (url === undefined || url === currentUrl) return;
    navigate(url);
  }, [followedView, editingDocumentId, documentId, currentUrl, navigate]);

  const canBack = cursor > 0;
  const canForward = cursor < history.length - 1;

  // Commit an address-bar entry.
  //
  // **On a room route it is a post, not a navigation** (spec `room-canvas`
  // §9.5). The Browser tab there shows the room's table, so typing an address is
  // putting a page on it as yourself: the server answers with a `canvas` frame
  // that reaches every member, and this frame follows it like everybody else's
  // does. Typing the same address again is a reload of the page in front of you,
  // which is nobody else's business and stays local.
  const submitAddress = useCallback(
    (value: string) => {
      const next = normalizeAddressInput(value);
      if (!next || next === currentUrl) {
        notePersonNavigated();
        setReloadNonce((n) => n + 1);
        return;
      }
      if (roomId) {
        setRefusedAddress(null);
        void openInRoom({ type: 'browser', url: next }).catch((error: unknown) => {
          setRefusedAddress({ url: next, message: roomCanvasRefusal(error) });
        });
        return;
      }
      // A person in THIS window typed an address, which is the plainest possible
      // statement that they are the one using this page — so it claims the
      // driver seat, exactly as opening the document here would (spec
      // `canvas-agent-seat` §2.2). Told to the BRIDGE rather than written to the
      // store: local navigation is this component's own state, and a store write
      // here would remount the frame and throw the history stack away.
      notePersonNavigated();
      navigate(next);
    },
    [currentUrl, navigate, roomId, openInRoom, notePersonNavigated]
  );

  // Always leaves the app, even for one of our own URLs — that is what the
  // button says it does.
  const openExternally = () => openExternalLink(currentUrl);

  return (
    <div className="flex h-full flex-col">
      <div className="border-border/60 flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1 lg:h-9 lg:flex-nowrap lg:py-0">
        <ChromeButton label="Back" disabled={!canBack} onClick={() => setCursor((c) => c - 1)}>
          <ArrowLeft className="size-4" />
        </ChromeButton>
        <ChromeButton
          label="Forward"
          disabled={!canForward}
          onClick={() => setCursor((c) => c + 1)}
        >
          <ArrowRight className="size-4" />
        </ChromeButton>
        <ChromeButton label="Reload" onClick={() => setReloadNonce((n) => n + 1)}>
          <RotateCw className="size-4" />
        </ChromeButton>
        {/* Keyed on the refusal so a failed post remounts the bar in edit mode,
            seeded with what was typed rather than with the page still on
            screen. */}
        <div className="order-first flex w-full min-w-0 lg:order-none lg:w-auto lg:flex-1">
          <AddressBar
            key={refusedAddress === null ? 'address' : `retry:${refusedAddress.url}`}
            url={refusedAddress?.url ?? currentUrl}
            startEditing={refusedAddress !== null}
            onSubmit={submitAddress}
          />
        </div>
        <ChromeButton label="Open in system browser" onClick={openExternally}>
          <ExternalLink className="size-4" />
        </ChromeButton>
      </div>

      {refusedAddress !== null && (
        <p role="status" className="text-destructive border-border/60 border-b px-2 py-1 text-xs">
          {refusedAddress.message}
        </p>
      )}

      {docFrame.requiresReload && (
        <p
          role="status"
          className="text-muted-foreground border-border/60 border-b px-2 py-1 text-xs"
        >
          Page is offline. Reload to reconnect.
        </p>
      )}

      <BrowserBody
        target={target}
        resolved={resolved}
        resolveError={resolveError}
        reloadNonce={reloadNonce}
        resourceErrorCount={resourceErrorCount}
        title={content.title ?? 'Embedded browser'}
        onOpenExternally={openExternally}
        onReload={() => {
          notePersonNavigated();
          setReloadNonce((n) => n + 1);
        }}
        iframeRef={iframeRef}
        onFrameLoad={(frame) => {
          docFrame.noteFrameLoaded(frame);
          noteFrameLoaded();
        }}
      />
    </div>
  );
}

/**
 * Chrome/Safari-style address bar. At rest it shows a simplified, honest view of
 * the logical URL (scheme + `www.` stripped, host emphasized, path dimmed; local
 * files shown as their source path behind a "local" chip — never the signed
 * token URL). Clicking or tab-focusing swaps to a text input pre-filled with the
 * full logical URL and select-all, so typing replaces immediately.
 *
 * Enter commits (navigate or reload); Escape and blur revert without navigating,
 * so an accidental focus never changes the page.
 */
function AddressBar({
  url,
  startEditing = false,
  onSubmit,
}: {
  url: string;
  /** Open as a text box rather than at rest — how a refused address is offered back. */
  startEditing?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(url);

  if (!editing) {
    return (
      <AddressDisplay
        url={url}
        onActivate={() => {
          setDraft(url);
          setEditing(true);
        }}
      />
    );
  }

  const commit = (e: React.FormEvent) => {
    e.preventDefault();
    setEditing(false);
    onSubmit(draft);
  };

  return (
    <form onSubmit={commit} className="min-w-0 flex-1">
      <Input
        aria-label="Address"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // Select-all on focus so typing replaces the current URL (browser behavior).
        onFocus={(e) => e.currentTarget.select()}
        // Revert on blur/Escape — focus alone must never navigate.
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-11 w-full text-base lg:h-7 lg:text-sm"
      />
    </form>
  );
}

/** The spoken location for an {@link AddressDisplay} accessible name. */
function locationLabel(display: ReturnType<typeof describeAddress>): string {
  if (display.kind === 'local') return display.path;
  if (display.kind === 'url') return `${display.host}${display.rest}`;
  return display.text;
}

/** At-rest address display: a focusable button rendering the simplified URL. */
function AddressDisplay({ url, onActivate }: { url: string; onActivate: () => void }) {
  const display = useMemo(() => describeAddress(url), [url]);

  return (
    <button
      type="button"
      // The accessible name carries WHERE the user is, not just what the
      // control is — a bare "Address" would override the visible location for
      // screen readers. Local files announce their logical path, never the
      // signed token URL.
      aria-label={`Address: ${locationLabel(display)}`}
      onClick={onActivate}
      className="text-muted-foreground hover:bg-muted focus-ring flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors lg:h-7"
    >
      {display.kind === 'local' && (
        <>
          <span className="bg-muted-foreground/15 text-3xs rounded px-1 py-0.5 font-medium tracking-wide uppercase">
            local
          </span>
          <span className="text-foreground truncate">{display.path}</span>
        </>
      )}
      {display.kind === 'url' && (
        <span className="truncate">
          <span className="text-foreground">{display.host}</span>
          <span className="text-muted-foreground">{display.rest}</span>
        </span>
      )}
      {display.kind === 'raw' && <span className="truncate">{display.text}</span>}
    </button>
  );
}

/** A single navigation-chrome icon button. */
function ChromeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-muted focus-ring flex size-11 shrink-0 items-center justify-center rounded-md transition-colors lg:size-7',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  );
}
