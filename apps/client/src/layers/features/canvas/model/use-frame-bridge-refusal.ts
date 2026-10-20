/**
 * Why a page in the embedded browser has no line to its agent (DOR-3131).
 *
 * DorkOS adds two scripts to a page it serves or previews: the page channel
 * (`window.dorkos.channel`) and the DevTools shim. When the page cannot carry
 * them safely it is served unchanged, and the server records why. This frame
 * cannot see that decision itself: a frame's response headers are invisible to
 * the page that framed it, and a dev server preview is another origin. So after
 * each `load` of the frame it asks the server, naming the page the way it
 * opened it, and answers the stable refusal code or `null`.
 *
 * @module features/canvas/model/use-frame-bridge-refusal
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { FrameBridgeRefusal, WorkbenchBridgeStatusRequest } from '@dorkos/shared/schemas';
import { useTransport } from '@/layers/shared/model';
import type { classifyBrowserTarget } from '../lib/browser-url';
import type { ResolvedFrame } from './use-resolved-frame';

/** What {@link useFrameBridgeRefusal} reads. */
export interface UseFrameBridgeRefusalParams {
  /** The rendered frame; only its own `load` events count. */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** The classified target for the URL currently open. */
  target: ReturnType<typeof classifyBrowserTarget>;
  /** The session working directory a local file is served from. */
  cwd: string | null;
  /** What the resolve cascade settled on, or `null`. */
  resolved: ResolvedFrame | null;
  /** Bumped on every reload. */
  reloadNonce: number;
}

/** The page to ask about, or `null` for a frame DorkOS adds nothing to. */
function bridgeQuery(
  target: UseFrameBridgeRefusalParams['target'],
  cwd: string | null,
  resolved: ResolvedFrame | null
): WorkbenchBridgeStatusRequest | null {
  if (!resolved?.bridgeEligibility) return null;
  if (target.mode === 'serve')
    return cwd === null ? null : { kind: 'serve', cwd, path: target.path };
  if (target.mode === 'proxy') return { kind: 'proxy', port: target.port, path: target.path };
  return null;
}

/**
 * The reason DorkOS did not add its scripts to the page in this frame, or
 * `null` when it did, when it does not know, or before the frame has loaded.
 *
 * @param params - The frame and the page it shows; see {@link UseFrameBridgeRefusalParams}.
 * @returns The stable refusal code, or `null`.
 */
export function useFrameBridgeRefusal({
  iframeRef,
  target,
  cwd,
  resolved,
  reloadNonce,
}: UseFrameBridgeRefusalParams): FrameBridgeRefusal | null {
  // A service handle, not an input: read through a ref so a fresh transport
  // object on each render does not re-arm the listener (see `useResolvedFrame`).
  const transport = useTransport();
  const transportRef = useRef(transport);
  useEffect(() => {
    transportRef.current = transport;
  });

  const query = bridgeQuery(target, cwd, resolved);
  const queryJson = query ? JSON.stringify(query) : null;
  // One answer per page load: a new page or a reload forgets the last answer.
  const pageKey = queryJson ? `${queryJson}\n${resolved?.src}\n${reloadNonce}` : null;
  const [found, setFound] = useState<{ pageKey: string; reason: FrameBridgeRefusal } | null>(null);

  // Layout, so the listener is in place before the frame can fire `load`. On
  // the document in the capture phase, because `load` does not bubble and the
  // frame element is replaced on every reload; only this frame's loads count.
  useLayoutEffect(() => {
    if (pageKey === null || queryJson === null) return;
    const ask: WorkbenchBridgeStatusRequest = JSON.parse(queryJson);
    let live = true;
    let latest = 0;
    const onLoad = (event: Event): void => {
      if (event.target !== iframeRef.current) return;
      const asked = ++latest;
      transportRef.current.getFrameBridgeStatus(ask).then(
        (status) => {
          if (!live || asked !== latest) return;
          setFound(
            status.bridge === 'refused' && status.reason ? { pageKey, reason: status.reason } : null
          );
        },
        // Nothing to say is better than a guess; the page itself still works.
        () => {}
      );
    };
    document.addEventListener('load', onLoad, true);
    return () => {
      live = false;
      document.removeEventListener('load', onLoad, true);
    };
  }, [pageKey, queryJson, iframeRef]);

  return found !== null && found.pageKey === pageKey ? found.reason : null;
}
