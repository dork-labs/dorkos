import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { BrowserHistoryState } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import { Input } from '@/layers/shared/ui';
import { cn, openExternalLink } from '@/layers/shared/lib';
import { useDevtoolsBridge } from '../model/use-devtools-bridge';
import {
  useResolvedFrame,
  type ResolveError,
  type ResolvedFrame,
} from '../model/use-resolved-frame';
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
const FRAME_LOAD_TIMEOUT_MS = 10_000;

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
  const { resourceErrorCount } = useDevtoolsBridge({
    iframeRef,
    documentId,
    logicalUrl: currentUrl,
    reloadNonce,
    previewOrigin: resolved?.previewOrigin ?? null,
  });

  const navigate = useCallback(
    (url: string) => {
      setHistory((h) => [...h.slice(0, cursor + 1), url]);
      setCursor((c) => c + 1);
    },
    [cursor]
  );

  const canBack = cursor > 0;
  const canForward = cursor < history.length - 1;

  // Commit an address-bar entry: navigate to a genuinely new target, else reload
  // the current one (re-minting its signed URL).
  const submitAddress = useCallback(
    (value: string) => {
      const next = normalizeAddressInput(value);
      if (next && next !== currentUrl) navigate(next);
      else setReloadNonce((n) => n + 1);
    },
    [currentUrl, navigate]
  );

  // Always leaves the app, even for one of our own URLs — that is what the
  // button says it does.
  const openExternally = () => openExternalLink(currentUrl);

  return (
    <div className="flex h-full flex-col">
      <div className="border-border/60 flex h-9 items-center gap-1 border-b px-2">
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
        <AddressBar url={currentUrl} onSubmit={submitAddress} />
        <ChromeButton label="Open in system browser" onClick={openExternally}>
          <ExternalLink className="size-4" />
        </ChromeButton>
      </div>

      <BrowserBody
        target={target}
        resolved={resolved}
        resolveError={resolveError}
        reloadNonce={reloadNonce}
        resourceErrorCount={resourceErrorCount}
        title={content.title ?? 'Embedded browser'}
        onOpenExternally={openExternally}
        onReload={() => setReloadNonce((n) => n + 1)}
        iframeRef={iframeRef}
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
function AddressBar({ url, onSubmit }: { url: string; onSubmit: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
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
        className="h-7 w-full text-sm"
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
      className="text-muted-foreground hover:bg-muted focus-ring flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm transition-colors"
    >
      {display.kind === 'local' && (
        <>
          <span className="bg-muted-foreground/15 rounded px-1 py-0.5 text-3xs font-medium tracking-wide uppercase">
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

interface BrowserBodyProps {
  target: ReturnType<typeof classifyBrowserTarget>;
  /** What the resolve cascade settled on, or `null` while it is still deciding. */
  resolved: ResolvedFrame | null;
  resolveError: ResolveError | null;
  reloadNonce: number;
  /** Resources the current document failed to load, as the DevTools bridge counted them. */
  resourceErrorCount: number;
  title: string;
  onOpenExternally: () => void;
  onReload: () => void;
  /** Ref attached to the rendered iframe so the DevTools bridge can identify it. */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

/**
 * One plain sentence for each way a preview can fail to appear, and a next step
 * in every one of them. Every branch here is a failure DorkOS can actually
 * detect — a blank frame is what this whole component exists to avoid, so
 * nothing is guessed and nothing is silent.
 *
 * @param error - What the resolve cascade concluded.
 * @param target - The classified target, so a message can name the address the
 *   user typed rather than a normalized one they never wrote.
 * @returns The sentence to show.
 */
function explainResolveError(
  error: ResolveError,
  target: ReturnType<typeof classifyBrowserTarget>
): string {
  switch (error.kind) {
    case 'no-session':
      return 'Open a session to preview local files.';
    case 'unsupported':
      return 'Local previews aren’t available in this environment.';
    case 'failed':
      return 'This preview couldn’t be loaded. Reload to try again, or open the app in your browser.';
    case 'tunnel':
      return 'Dev-server previews aren’t available through a tunnel. Open DorkOS on the machine that runs it, or open the app in your browser.';
    case 'no-port':
      return 'All preview ports are in use. Close a preview, then reload.';
    case 'origin-unreachable':
      // DorkOS can see the dev server; this browser cannot reach the port
      // DorkOS opened for it. Almost always a forwarded port that was not
      // forwarded wide enough — so the fix named is the one that always works.
      return `DorkOS can see your dev server, but this connection doesn’t reach port ${error.listenPort} on ${error.host}. Open DorkOS on the machine that runs it, or open the app in your browser.`;
    case 'no-upstream': {
      // Named the way the user typed it: someone who entered `127.0.0.1:5399`
      // and is told about `localhost` doubts the message instead of the port.
      const where = target.mode === 'proxy' ? `${target.hostname}:${target.port}` : 'that address';
      return `Nothing is listening on ${where}. Start the dev server, then reload.`;
    }
  }
}

/** The frame (or a message) for the current navigation state. */
function BrowserBody({
  target,
  resolved,
  resolveError,
  reloadNonce,
  resourceErrorCount,
  title,
  onOpenExternally,
  onReload,
  iframeRef,
}: BrowserBodyProps) {
  if (target.mode === 'blocked') {
    return <BrowserMessage>This address can’t be displayed for security reasons.</BrowserMessage>;
  }
  if (resolveError !== null) {
    return (
      <BrowserMessage>
        <p>{explainResolveError(resolveError, target)}</p>
        {resolveError.kind !== 'no-session' && resolveError.kind !== 'unsupported' && (
          <button type="button" onClick={onReload} className="text-foreground mt-3 hover:underline">
            Reload
          </button>
        )}
      </BrowserMessage>
    );
  }
  if (resolved === null) {
    return <BrowserMessage>Loading…</BrowserMessage>;
  }

  const external = target.mode === 'external';

  return (
    <PreviewFrame
      // One mount per document the frame loads: reload re-mints the src, and a
      // reload of the SAME src still bumps the nonce. Remounting is also what
      // resets "has it loaded yet" and "is it past its deadline" — a page's
      // loading state belongs to that page and nothing else.
      key={`${resolved.src}:${reloadNonce}`}
      src={resolved.src}
      sandbox={resolved.sandbox}
      title={title}
      iframeRef={iframeRef}
      // An external site's slowness is the site's, and its escape hatch is
      // already below the frame; the deadline is for previews DorkOS put there.
      watchLoadDeadline={!external}
      resourceErrorCount={resourceErrorCount}
      showEmbedFallback={external}
      onOpenExternally={onOpenExternally}
      onReload={onReload}
    />
  );
}

interface PreviewFrameProps {
  src: string;
  sandbox: string;
  title: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Whether to warn when this frame takes too long to fire `load`. */
  watchLoadDeadline: boolean;
  resourceErrorCount: number;
  /** Whether to show the always-on "this site may refuse framing" footer. */
  showEmbedFallback: boolean;
  onOpenExternally: () => void;
  onReload: () => void;
}

/**
 * The frame itself, plus the two things that can be said about a page while it
 * is mounted: it is taking too long, and it failed to load some of its own
 * files. Both are banners above a frame that stays put — a slow or partly broken
 * page is still a page, and unmounting it would throw away a load in progress.
 */
function PreviewFrame({
  src,
  sandbox,
  title,
  iframeRef,
  watchLoadDeadline,
  resourceErrorCount,
  showEmbedFallback,
  onOpenExternally,
  onReload,
}: PreviewFrameProps) {
  const [loaded, setLoaded] = useState(false);
  const [pastDeadline, setPastDeadline] = useState(false);

  // One clock per mount, and the caller remounts this component per document —
  // so the deadline starts over with each page and never carries across one.
  useEffect(() => {
    if (!watchLoadDeadline) return;
    const timer = setTimeout(() => setPastDeadline(true), FRAME_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [watchLoadDeadline]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pastDeadline && !loaded && (
        <FrameBanner onOpenExternally={onOpenExternally} onReload={onReload}>
          This preview is taking a long time to load.
        </FrameBanner>
      )}
      {resourceErrorCount > 0 && (
        <FrameBanner onOpenExternally={onOpenExternally}>
          This page hit {resourceErrorCount} {resourceErrorCount === 1 ? 'error' : 'errors'} while
          loading.
        </FrameBanner>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        sandbox={sandbox}
        onLoad={() => setLoaded(true)}
        className="min-h-0 w-full flex-1 border-0"
        title={title}
      />
      {showEmbedFallback && (
        // Honest escape hatch: some external sites refuse framing, and that
        // can't be reliably detected cross-origin — so always offer this.
        <div className="text-muted-foreground border-border/60 flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs">
          <span>This site can’t always be embedded here.</span>
          <button
            type="button"
            onClick={onOpenExternally}
            className="text-foreground hover:underline"
          >
            Open in system browser
          </button>
        </div>
      )}
    </div>
  );
}

/** A slim message strip above the frame, with the ways out of what it reports. */
function FrameBanner({
  children,
  onOpenExternally,
  onReload,
}: {
  children: React.ReactNode;
  onOpenExternally: () => void;
  onReload?: () => void;
}) {
  return (
    <div className="text-muted-foreground border-border/60 flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
      <span>{children}</span>
      <span className="flex shrink-0 items-center gap-3">
        {onReload && (
          <button type="button" onClick={onReload} className="text-foreground hover:underline">
            Reload
          </button>
        )}
        <button
          type="button"
          onClick={onOpenExternally}
          className="text-foreground hover:underline"
        >
          Open in system browser
        </button>
      </span>
    </div>
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
        'text-muted-foreground hover:text-foreground hover:bg-muted focus-ring rounded-md p-1.5 transition-colors',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      {children}
    </button>
  );
}

/** Centered muted message for browser empty/error states. */
function BrowserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      {children}
    </div>
  );
}
