/**
 * Deciding what the embedded browser should actually load, and saying so when it
 * cannot (DOR-1259, DOR-1260).
 *
 * A dev server is the interesting case, because "can this page load
 * `localhost:5178`?" has three different answers depending on where the person
 * is sitting, and only the browser itself can give the last one. The cascade
 * below asks in the order that gets the most people a working preview:
 *
 * 1. Does the machine running DorkOS see anything on that port?
 * 2. If it might, take a preview origin for it and ask THIS browser whether it
 *    can reach that origin. This is the answer that works from a phone, a
 *    tablet, or a second laptop, and it is the only one carrying the DevTools
 *    shim — so it is tried first.
 * 3. Otherwise, if this page is open on the machine running the dev server, load
 *    the dev server's own address. This is what saves "dev server on my laptop,
 *    DorkOS in a container", where the preview port was never forwarded.
 * 4. Otherwise say which of the two things went wrong, in a sentence with a next
 *    step in it. Never a blank frame.
 *
 * @module features/canvas/model/use-resolved-frame
 */
import { useEffect, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import {
  classifyBrowserTarget,
  splicePreviewPath,
  type LoopbackStrategy,
  PREVIEW_HEALTH_PATH,
  WORKBENCH_SANDBOX_EXTERNAL,
  WORKBENCH_SANDBOX_ISOLATED,
} from '../lib/browser-url';
import { probeDirect } from '../lib/probe-direct';

/**
 * Why there is no frame, in enough detail to say something useful about it.
 * Carried as a shape rather than a string because two of these have to name the
 * address the user would have to go fix.
 */
export type ResolveError =
  | { kind: 'no-session' }
  | { kind: 'unsupported' }
  | { kind: 'failed' }
  | { kind: 'no-upstream' }
  | { kind: 'tunnel' }
  | { kind: 'no-port' }
  | { kind: 'origin-unreachable'; host: string; listenPort: string };

/** What the cascade settled on: a source, how to sandbox it, and who may talk back. */
export interface ResolvedFrame {
  /** The URL to load. */
  src: string;
  /** The iframe `sandbox` value this particular source has earned. */
  sandbox: string;
  /**
   * The origin the DevTools shim is allowed to speak from for this document,
   * beyond an opaque frame's `'null'`. Set only for a preview listener, which is
   * the only real origin DorkOS injects the shim into.
   */
  previewOrigin: string | null;
}

/** What {@link useResolvedFrame} is asked to resolve. */
export interface UseResolvedFrameParams {
  /** The classified target for the URL currently open. */
  target: ReturnType<typeof classifyBrowserTarget>;
  /** The logical URL currently open (never a signed or bootstrap URL). */
  currentUrl: string;
  /** Whether this page could load a dev server's own address, or `null` for non-dev targets. */
  strategy: LoopbackStrategy | null;
  /** The session working directory, or `null` when no session is attached. */
  cwd: string | null;
  /** Bumped on every reload, so each one re-mints (tokens expire). */
  reloadNonce: number;
}

/** The outcome: a frame to render, or a reason there is none. */
export interface UseResolvedFrame {
  resolved: ResolvedFrame | null;
  resolveError: ResolveError | null;
}

/**
 * Resolve what to put in the browser frame. See the module doc for the cascade.
 *
 * @param params - The target and the facts the cascade needs — see {@link UseResolvedFrameParams}.
 * @returns The frame to render, or why there isn't one — see {@link UseResolvedFrame}.
 */
export function useResolvedFrame({
  target,
  currentUrl,
  strategy,
  cwd,
  reloadNonce,
}: UseResolvedFrameParams): UseResolvedFrame {
  const [resolved, setResolved] = useState<ResolvedFrame | null>(null);
  const [resolveError, setResolveError] = useState<ResolveError | null>(null);

  // The transport is a service handle, not an input: WHICH transport is in play
  // never changes what a URL should resolve to, so a caller that builds a fresh
  // one each render must not send this whole cascade round again. Read through a
  // ref, and left out of the dependency list on purpose — with it in, an
  // unstable transport re-runs the effect, the effect stores a result, React
  // re-renders to see whether it can bail, the effect re-runs, and a preview
  // re-mints itself forever at 100% of a CPU. (Measured: it does.)
  const transport = useTransport();
  const transportRef = useRef(transport);
  useEffect(() => {
    transportRef.current = transport;
  });

  useEffect(() => {
    const transport = transportRef.current;
    let cancelled = false;

    async function resolveServe(path: string): Promise<void> {
      if (cwd === null) {
        setResolveError({ kind: 'no-session' });
        return;
      }
      try {
        // Relative paths resolve against the CURRENT session cwd. A persisted
        // document restored into a session with a different cwd can fail the
        // server's cwd-confinement check on re-mint (surfaced as 'failed').
        const url = await transport.createServeUrl(cwd, path);
        if (cancelled) return;
        if (url === null) setResolveError({ kind: 'unsupported' });
        else setResolved({ src: url, sandbox: WORKBENCH_SANDBOX_ISOLATED, previewOrigin: null });
      } catch {
        if (!cancelled) setResolveError({ kind: 'failed' });
      }
    }

    async function resolveDevServer(port: number, path: string): Promise<void> {
      // 1. Does the machine running DorkOS see anything on that port?
      let serverSees: boolean | 'unknown';
      try {
        const probe = await transport.probeLoopbackPort(port);
        // A `null` answer means the transport has no server to ask (Obsidian) —
        // unknown, not empty, so nothing is claimed.
        serverSees = probe === null ? 'unknown' : probe.listening;
      } catch {
        serverSees = 'unknown';
      }
      if (cancelled) return;

      // 2. If it might, take a preview origin — and then ask THIS browser
      //    whether it can reach that origin, because the server's answer is
      //    about the server's network, not the viewer's.
      // What to say if step 3 cannot save this either. Held rather than shown,
      // because every one of these still leaves the direct frame worth trying —
      // a preview origin that could not be opened says nothing about whether
      // this page can reach the dev server's own address.
      let fallbackError: ResolveError | null = null;
      if (serverSees !== false) {
        let minted: Awaited<ReturnType<typeof transport.createProxyUrl>> = null;
        try {
          minted = await transport.createProxyUrl(port);
        } catch {
          if (cancelled) return;
          fallbackError = { kind: 'failed' };
        }
        if (cancelled) return;
        if (minted?.unavailable === 'tunnel') {
          // The one terminal answer, because it is the one that also rules out
          // step 3: a tunnel hostname is not a loopback host, so this page's
          // `localhost` is the viewer's own machine and framing the dev server's
          // address there would load nothing.
          setResolveError({ kind: 'tunnel' });
          return;
        }
        if (minted?.unavailable === 'no-port') {
          fallbackError = { kind: 'no-port' };
        }
        if (minted?.url) {
          const origin = new URL(minted.url);
          // The listener answers this path without a cookie, so the probe needs
          // no bootstrap and spends no token.
          if (await probeDirect(`${origin.origin}${PREVIEW_HEALTH_PATH}`)) {
            if (cancelled) return;
            const src = splicePreviewPath(minted.url, path);
            if (src !== null) {
              // Its own origin, so it gets the external sandbox — and it is the
              // one framed page carrying our shim, so the bridge is told which
              // origin may speak.
              setResolved({
                src,
                sandbox: WORKBENCH_SANDBOX_EXTERNAL,
                previewOrigin: origin.origin,
              });
              return;
            }
          }
          if (cancelled) return;
          fallbackError = {
            kind: 'origin-unreachable',
            host: origin.hostname,
            listenPort: origin.port,
          };
        }
      }

      // 3. This page is open ON the machine running the dev server, so its own
      //    address may work even when the preview origin does not.
      if (strategy === 'direct' && (await probeDirect(currentUrl))) {
        if (cancelled) return;
        setResolved({
          src: currentUrl,
          sandbox: WORKBENCH_SANDBOX_EXTERNAL,
          previewOrigin: null,
        });
        return;
      }
      if (cancelled) return;

      // 4. Nothing worked. Say what actually went wrong, which is whatever
      //    stopped step 2 — or, if step 2 never had anything to work with,
      //    that there is nothing on the port at all.
      setResolveError(fallbackError ?? { kind: 'no-upstream' });
    }

    async function resolve(): Promise<void> {
      setResolveError(null);
      setResolved(null);
      if (target.mode === 'blocked') return;
      if (target.mode === 'external') {
        setResolved({
          src: target.url,
          sandbox: WORKBENCH_SANDBOX_EXTERNAL,
          previewOrigin: null,
        });
        return;
      }
      if (target.mode === 'serve') return resolveServe(target.path);
      return resolveDevServer(target.port, target.path);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [target, currentUrl, strategy, cwd, reloadNonce]);

  return { resolved, resolveError };
}
