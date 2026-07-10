import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
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
   * Browser or URL canvas content — both render here (DOR-233): every webpage
   * opened in the canvas gets navigation chrome and origin isolation. The two
   * variants differ only in the schema-level shape of `url`; the renderer reads
   * `url` and `title` and treats them identically.
   */
  content: Extract<UiCanvasContent, { type: 'browser' | 'url' }>;
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
export function CanvasBrowserContent({ content }: CanvasBrowserContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  // In-component navigation history: a stack of visited logical targets + a
  // cursor. The stack holds LOGICAL urls/paths (never the signed token URLs) so
  // the address bar can display them honestly and each navigation/reload re-mints
  // a fresh signed URL (tokens expire).
  const [history, setHistory] = useState<string[]>([content.url]);
  const [cursor, setCursor] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);

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

/** At-rest address display: a focusable button rendering the simplified URL. */
function AddressDisplay({ url, onActivate }: { url: string; onActivate: () => void }) {
  const display = useMemo(() => describeAddress(url), [url]);

  return (
    <button
      type="button"
      aria-label="Address"
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
