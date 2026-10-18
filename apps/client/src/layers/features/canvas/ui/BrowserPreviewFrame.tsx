/** The frame (or the sentence that replaces it) for the browser view's current navigation. */
import { useEffect, useState } from 'react';
import type { ResolveError, ResolvedFrame } from '../model/use-resolved-frame';
import type { classifyBrowserTarget } from '../lib/browser-url';

const FRAME_LOAD_TIMEOUT_MS = 10_000;

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
  /** Every document the frame loads, including ones the page navigates to itself. */
  onFrameLoad: (frame: HTMLIFrameElement) => void;
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
      return 'Open a chat to preview local files.';
    case 'unsupported':
      return 'Local previews aren’t available in this environment.';
    case 'failed':
      return 'Couldn’t load this preview. Reload, or open the app in your browser.';
    case 'tunnel':
      return 'Dev server previews don’t work remotely. Open DorkOS on the computer running it.';
    case 'no-port':
      return 'All preview ports are in use. Close a preview, then reload.';
    case 'origin-unreachable':
      // DorkOS can see the dev server; this browser cannot reach the port
      // DorkOS opened for it. Almost always a forwarded port that was not
      // forwarded wide enough — so the fix named is the one that always works.
      return `This view can’t reach port ${error.listenPort} on ${error.host}. Open DorkOS on the computer running it.`;
    case 'no-upstream': {
      // Named the way the user typed it: someone who entered `127.0.0.1:5399`
      // and is told about `localhost` doubts the message instead of the port.
      const where = target.mode === 'proxy' ? `${target.hostname}:${target.port}` : 'that address';
      return `Nothing is listening on ${where}. Start the dev server, then reload.`;
    }
  }
}

/** The frame (or a message) for the current navigation state. */
export function BrowserBody({
  target,
  resolved,
  resolveError,
  reloadNonce,
  resourceErrorCount,
  title,
  onOpenExternally,
  onReload,
  iframeRef,
  onFrameLoad,
}: BrowserBodyProps) {
  if (target.mode === 'blocked') {
    return <BrowserMessage>This address is blocked for safety.</BrowserMessage>;
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
      onFrameLoad={onFrameLoad}
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
  /** Every document the frame loads, including ones the page navigates to itself. */
  onFrameLoad: (frame: HTMLIFrameElement) => void;
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
  onFrameLoad,
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
          This preview is slow to load.
        </FrameBanner>
      )}
      {resourceErrorCount > 0 && (
        <FrameBanner onOpenExternally={onOpenExternally}>
          This page hit {resourceErrorCount === 10000 ? 'at least 10,000' : resourceErrorCount}{' '}
          {resourceErrorCount === 1 ? 'error' : 'errors'} while loading.
        </FrameBanner>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        sandbox={sandbox}
        onLoad={(event) => {
          setLoaded(true);
          onFrameLoad(event.currentTarget);
        }}
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

/** Centered muted message for browser empty/error states. */
function BrowserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      {children}
    </div>
  );
}
