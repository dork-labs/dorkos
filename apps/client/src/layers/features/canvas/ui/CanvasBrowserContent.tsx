import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { BrowserHistoryState } from '@/layers/shared/model';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  classifyBrowserTarget,
  describeAddress,
  normalizeAddressInput,
  WORKBENCH_SANDBOX_EXTERNAL,
  WORKBENCH_SANDBOX_ISOLATED,
} from '../lib/browser-url';

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
type ResolveError = 'no-session' | 'unsupported' | 'failed' | null;

/**
 * Embedded browser canvas with navigation chrome (back/forward/reload/address
 * bar). Local files and localhost dev servers are routed through the signed
 * serve/proxy routes and rendered in an opaque-origin sandbox (no
 * `allow-same-origin`, ADR 260708-185519) so untrusted content can never call
 * `/api/*` as the user. External sites are framed directly.
 *
 * Honesty about embedding: an external site's `X-Frame-Options` /
 * `frame-ancestors` refusal cannot be reliably detected from the parent (a
 * blocked frame still fires `load` cross-origin), so rather than guess, the
 * browser always surfaces an "open in system browser" affordance for external
 * pages — the escape hatch is present whether or not the frame renders.
 *
 * DevTools bridge seam (DOR-213, v2): the proxy already sees all preview
 * traffic, and console/network capture will attach as an injected script on
 * served pages — no rework of this component is needed to add it.
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

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<ResolveError>(null);

  // Resolve the frame source: mint a signed URL for served/proxied local
  // content, or use the external URL directly. Re-runs on navigation + reload.
  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      setResolveError(null);
      setResolvedSrc(null);
      if (target.mode === 'blocked') return;
      if (target.mode === 'external') {
        setResolvedSrc(target.url);
        return;
      }
      if (target.mode === 'serve' && cwd === null) {
        setResolveError('no-session');
        return;
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
  }, [target, cwd, transport, reloadNonce]);

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

  const openExternally = () => window.open(currentUrl, '_blank', 'noopener,noreferrer');

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
        resolvedSrc={resolvedSrc}
        resolveError={resolveError}
        reloadNonce={reloadNonce}
        title={content.title ?? 'Embedded browser'}
        onOpenExternally={openExternally}
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
  resolvedSrc: string | null;
  resolveError: ResolveError;
  reloadNonce: number;
  title: string;
  onOpenExternally: () => void;
}

/** The frame (or a message) for the current navigation state. */
function BrowserBody({
  target,
  resolvedSrc,
  resolveError,
  reloadNonce,
  title,
  onOpenExternally,
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
  if (resolveError === 'failed') {
    return <BrowserMessage>This preview couldn’t be loaded.</BrowserMessage>;
  }
  if (resolvedSrc === null) {
    return <BrowserMessage>Loading…</BrowserMessage>;
  }

  const external = target.mode === 'external';
  const sandbox = external ? WORKBENCH_SANDBOX_EXTERNAL : WORKBENCH_SANDBOX_ISOLATED;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        // Remount on reload so the frame reloads even when the src is unchanged.
        key={`${resolvedSrc}:${reloadNonce}`}
        src={resolvedSrc}
        sandbox={sandbox}
        className="min-h-0 w-full flex-1 border-0"
        title={title}
      />
      {external && (
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
