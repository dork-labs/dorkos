import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { BrowserHistoryState } from '@/layers/shared/model';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Input } from '@/layers/shared/ui';
import { cn, openExternalLink } from '@/layers/shared/lib';
import { useDevtoolsBridge } from '../model/use-devtools-bridge';
import {
  classifyBrowserTarget,
  describeAddress,
  loopbackStrategy,
  normalizeAddressInput,
  WORKBENCH_SANDBOX_EXTERNAL,
  WORKBENCH_SANDBOX_ISOLATED,
} from '../lib/browser-url';
import { probeDirect } from '../lib/probe-direct';

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

/** Why the frame has no resolvable source (served/proxied local content only). */
type ResolveError = 'no-session' | 'unsupported' | 'failed' | 'no-upstream' | null;

/**
 * Embedded browser canvas with navigation chrome (back/forward/reload/address
 * bar). Local files are routed through the signed serve route and rendered in an
 * opaque-origin sandbox (no `allow-same-origin`, ADR 260708-185519) so untrusted
 * content can never call `/api/*` as the user. External sites are framed
 * directly. A localhost dev server is framed by its own URL when the cockpit is
 * running on the same machine, and routed through the signed proxy otherwise —
 * see `loopbackStrategy`.
 *
 * Honesty about embedding, in three parts:
 * - An external site's `X-Frame-Options` / `frame-ancestors` refusal cannot be
 *   reliably detected from the parent (a blocked frame still fires `load`
 *   cross-origin), so rather than guess, the browser always surfaces an "open in
 *   system browser" affordance for external pages.
 * - A dev-server port is checked before it is framed, so a port with nothing on
 *   it is a sentence rather than a white rectangle.
 * - A frame that never finishes loading, and a page whose own resources failed,
 *   both say so above the frame — which stays mounted, because a slow or partly
 *   broken page is still a page.
 */
export function CanvasBrowserContent({ documentId, content }: CanvasBrowserContentProps) {
  const transport = useTransport();
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

  // DevTools bridge seam (DOR-213): relay the served/proxied preview's console +
  // network to the attached session. The shim talks only to this frame's parent
  // (never `/api/*`); this hook is that parent. Inert for external frames and for
  // a directly framed dev server (nothing injects the shim into either), and when
  // no session is attached.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { resourceErrorCount } = useDevtoolsBridge({
    iframeRef,
    documentId,
    logicalUrl: currentUrl,
    reloadNonce,
  });

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<ResolveError>(null);
  // Whether the CURRENT `resolvedSrc` is the dev server's own URL. An outcome of
  // the cascade below, not a property of the target — so the sandbox is chosen
  // from what was actually loaded rather than from what was hoped for.
  const [framedDirectly, setFramedDirectly] = useState(false);

  // Resolve the frame source: mint a signed URL for served/proxied local
  // content, or use the external URL directly. Re-runs on navigation + reload.
  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      setResolveError(null);
      setResolvedSrc(null);
      setFramedDirectly(false);
      if (target.mode === 'blocked') return;
      if (target.mode === 'external') {
        setResolvedSrc(target.url);
        return;
      }
      if (target.mode === 'serve' && cwd === null) {
        setResolveError('no-session');
        return;
      }
      if (target.mode === 'proxy' && strategy === 'direct') {
        // Ask the BROWSER, not the server. The server's port probe answers about
        // the machine running DorkOS, and on a forwarded port (`docker run -p`,
        // `ssh -L`) that is not the machine looking at this page — it would say
        // "yes, it's listening" about a port this browser cannot reach. Chrome
        // then renders its own connection-refused page and fires `load`, so even
        // the slow-preview banner stays quiet: a silent blank rectangle.
        //
        // Three outcomes, and `probeDirect` folds the two that share an answer:
        // - it answers        → frame it directly;
        // - it REFUSES        → this browser cannot reach it, so fall through to
        //                       the server, which on a forwarded port still can;
        // - it stays SILENT   → still compiling, not missing. Frame it directly
        //                       anyway; the frame's own 10-second load deadline
        //                       is what speaks up if nothing ever arrives.
        if (await probeDirect(currentUrl)) {
          if (cancelled) return;
          // The dev server's own URL, so its root-absolute assets, its router
          // and its live-reload socket all resolve against the server that
          // serves them.
          setFramedDirectly(true);
          setResolvedSrc(currentUrl);
          return;
        }
        if (cancelled) return;
        // Refused from here — but the machine running DorkOS may still reach it,
        // which is exactly the forwarded-port case. Fall through to the server,
        // which either proxies it or says nothing is there.
      }
      if (target.mode === 'proxy') {
        // A `null` answer means the transport has no server to ask (Obsidian) —
        // unknown, not empty, so nothing is claimed and the mint goes ahead.
        let probe: { listening: boolean } | null;
        try {
          probe = await transport.probeLoopbackPort(target.port);
        } catch {
          probe = null;
        }
        if (cancelled) return;
        if (probe !== null && !probe.listening) {
          setResolveError('no-upstream');
          return;
        }
      }
      try {
        let url: string | null;
        if (target.mode === 'proxy') {
          const base = await transport.createProxyUrl(target.port);
          const suffix = target.path.replace(/^\//, '');
          url = base && suffix ? base + suffix : base;
        } else {
          // Relative paths resolve against the CURRENT session cwd. A persisted
          // document restored into a session with a different cwd can fail the
          // server's cwd-confinement check on re-mint (surfaced as 'failed').
          url = await transport.createServeUrl(cwd as string, target.path);
        }
        if (cancelled) return;
        if (url === null) setResolveError('unsupported');
        else setResolvedSrc(url);
      } catch {
        if (!cancelled) setResolveError('failed');
      }
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [target, currentUrl, strategy, cwd, transport, reloadNonce]);

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
        framedDirectly={framedDirectly}
        resolvedSrc={resolvedSrc}
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
          <span className="bg-muted-foreground/15 rounded px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase">
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
  /** Whether a loopback target is framed by its own URL rather than via the server. */
  framedDirectly: boolean;
  resolvedSrc: string | null;
  resolveError: ResolveError;
  reloadNonce: number;
  /** Resources the current document failed to load, as the DevTools bridge counted them. */
  resourceErrorCount: number;
  title: string;
  onOpenExternally: () => void;
  onReload: () => void;
  /** Ref attached to the rendered iframe so the DevTools bridge can identify it. */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}

/** The frame (or a message) for the current navigation state. */
function BrowserBody({
  target,
  framedDirectly,
  resolvedSrc,
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
  if (resolveError === 'no-session') {
    return <BrowserMessage>Open a session to preview local files.</BrowserMessage>;
  }
  if (resolveError === 'unsupported') {
    return <BrowserMessage>Local previews aren’t available in this environment.</BrowserMessage>;
  }
  if (resolveError === 'no-upstream') {
    // Named the way the user typed it: someone who entered `127.0.0.1:5399` and
    // is told about `localhost` doubts the message instead of the port.
    const where = target.mode === 'proxy' ? `${target.hostname}:${target.port}` : 'that address';
    return (
      <BrowserMessage>
        <p>Nothing is listening on {where}. Start the dev server, then reload.</p>
        <button type="button" onClick={onReload} className="text-foreground mt-3 hover:underline">
          Reload
        </button>
      </BrowserMessage>
    );
  }
  if (resolveError === 'failed') {
    return <BrowserMessage>This preview couldn’t be loaded.</BrowserMessage>;
  }
  if (resolvedSrc === null) {
    return <BrowserMessage>Loading…</BrowserMessage>;
  }

  const external = target.mode === 'external';
  // A directly framed dev server is on its own origin, exactly like an external
  // site, so it gets the same sandbox — see `loopbackStrategy` for why that
  // grants it nothing against the DorkOS origin. `framedDirectly` is the outcome
  // of the resolve cascade, so this reads what was loaded, never an intention:
  // a target that failed the browser's own reachability check never reaches
  // here as a direct frame at all. Anything DorkOS itself serves keeps the
  // opaque origin (ADR 260708-185519).
  const sandbox =
    external || framedDirectly ? WORKBENCH_SANDBOX_EXTERNAL : WORKBENCH_SANDBOX_ISOLATED;

  return (
    <PreviewFrame
      // One mount per document the frame loads: reload re-mints the src, and a
      // reload of the SAME src still bumps the nonce. Remounting is also what
      // resets "has it loaded yet" and "is it past its deadline" — a page's
      // loading state belongs to that page and nothing else.
      key={`${resolvedSrc}:${reloadNonce}`}
      src={resolvedSrc}
      sandbox={sandbox}
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
