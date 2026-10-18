/**
 * Host side of `window.dorkos.channel`: connects a page in a canvas browser
 * frame to its document over one dedicated MessagePort per loaded page.
 *
 * The frame's own `load` event is the only proof that a page is there. Every
 * load gets a fresh capture, binding and handshake, so a page that reloads or
 * navigates itself reconnects on its own, and the page it replaced can never
 * keep a live port. The handshake then refuses any window but this frame and
 * any origin but the exact one the host minted (`null` for a served document).
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTransport } from '@/layers/shared/model';
import { FrameLifetimeController, DocFrameHandshake } from '@/layers/shared/lib/canvas-doc-frame';
import { useDocChannel } from './use-doc-channel';

/** What the host knows about the frame it renders; nothing here comes from the page. */
export interface DocFrameChannelParams {
  /** The rendered iframe. Its load events are the only witness of a loaded page. */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  documentId: string;
  logicalUrl: string;
  reloadNonce: number;
  /** The URL the frame was given, or `null` while it is still resolving. */
  resolvedSource: string | null;
  /** How DorkOS serves (and instruments) the page; `null` for anything it does not serve. */
  bridgeEligibility: 'served-document' | 'preview-listener' | null;
  /** The minted origin a preview page must answer from. */
  previewOrigin: string | null;
}

/** What the browser view needs from the page channel. */
export interface DocFrameChannel {
  /** A page that was connected lost its connection, and only a reload can bring it back. */
  requiresReload: boolean;
  /** Call from the iframe's `load` event: a new document is in the frame. */
  noteFrameLoaded(iframe: HTMLIFrameElement): void;
}

/** One document loaded into the current frame element. */
interface PageLoad {
  frame: Window;
  /** Highest docSeq this document was sent, kept across reconnects so no event repeats. */
  delivered: number;
}

/** One handshake with one loaded page. */
interface Link {
  load: PageLoad;
  handshake: DocFrameHandshake;
  live: boolean;
  /** Closed by this host (navigation, unmount, invalidation) rather than by the page. */
  hostClosed: boolean;
  stateRev: number;
}

/** Everything belonging to one physical navigation (one `key`). */
interface Mount {
  key: string;
  transport: object;
  /** False while React has the view hidden (Suspense) or unmounted. */
  active: boolean;
  load: PageLoad | null;
  /** The current link; a closed one stays here so nothing retries until the page loads again. */
  link: Link | null;
  /** Inputs of the last attempt, so a refused attempt is not repeated on every render. */
  tried: readonly unknown[] | null;
  invalidations: number;
  everLive: boolean;
}

const HANDSHAKE_SCHEDULER = {
  random: () => Math.random(),
  schedule: (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Connect the page in a canvas browser frame to its document's channel.
 *
 * @param params - Host-resolved facts about the frame and what it shows.
 * @returns Whether to tell the person the page needs a reload, and the load hook.
 */
export function useDocFrameChannel(params: DocFrameChannelParams): DocFrameChannel {
  const transport = useTransport();
  const doc = useDocChannel(params.documentId);
  const [controller] = useState(() => new FrameLifetimeController());
  const [failed, setFailed] = useState<{ key: string; transport: object } | null>(null);
  const key = JSON.stringify([
    params.documentId,
    params.logicalUrl,
    params.resolvedSource,
    params.reloadNonce,
    params.bridgeEligibility,
    params.previewOrigin,
  ]);
  const mount = useRef<Mount | null>(null);
  const latest = useRef({ params, doc, key, transport });
  // Set while this hook's own capture runs: the admission facade notifies its
  // subscribers synchronously from inside prepare/attach, and that is not an
  // invalidation of anything this hook still holds.
  const attempting = useRef(false);
  const attempts = useRef(0);

  // Plain functions reading refs; the effects and handlers below call the
  // latest copy through `ops`, so none of them closes over a stale render.
  const disconnect = (m: Mount) => {
    const link = m.link;
    m.link = null;
    if (link) {
      link.hostClosed = true;
      link.handshake.close();
    }
    controller.retire();
  };

  const publish = () => {
    const link = mount.current?.link;
    const { doc: own } = latest.current;
    const snapshot = own.snapshot;
    if (!link?.live || !snapshot || !own.channel.current?.('read')) return;
    // Events before state: the page drops any event at or below the state's docSeq.
    for (const frame of own.events) {
      if (frame.docSeq <= link.load.delivered) continue;
      link.handshake.publish({ kind: 'event', frame });
      link.load.delivered = frame.docSeq;
    }
    if (snapshot.stateRev > link.stateRev) {
      link.handshake.publish({
        kind: 'state',
        state: snapshot.state,
        stateRev: snapshot.stateRev,
        docSeq: snapshot.highWatermark,
        reset: snapshot.resetRequired,
      });
      link.stateRev = snapshot.stateRev;
    }
  };

  const connect = () => {
    const m = mount.current;
    const { params: own, doc: owner, key: ownKey, transport: ownTransport } = latest.current;
    const element = own.iframeRef.current;
    const load = m?.load;
    const admission = owner.frameAdmission;
    if (
      !m?.active ||
      m.link ||
      !load ||
      m.key !== ownKey ||
      m.transport !== ownTransport ||
      !own.resolvedSource ||
      !own.bridgeEligibility ||
      !element?.isConnected ||
      element.contentWindow !== load.frame ||
      !admission ||
      !owner.snapshot ||
      // Admission refuses a document with no approved route; waiting here lets
      // the page connect by itself the moment one is approved.
      !owner.channel.enabled ||
      !owner.channel.current?.('read')
    )
      return;
    const tried = [load, admission, owner.snapshot, m.invalidations];
    if (m.tried?.every((value, index) => value === tried[index])) return;
    m.tried = tried;
    attempting.current = true;
    try {
      const observation = controller.observeHostContext({
        frame: load.frame,
        documentId: own.documentId,
        resolvedSource: own.resolvedSource,
        logicalUrl: own.logicalUrl,
        reloadKey: `${own.reloadNonce}:${++attempts.current}`,
        sessionId: null,
        eligibility: own.bridgeEligibility,
        exactOrigin: own.bridgeEligibility === 'served-document' ? 'null' : own.previewOrigin,
        transportOwner: ownTransport,
        publisherEpoch: attempts.current,
      });
      const loaded =
        observation && admission.prepareFrameLoad(controller, observation)?.completeLoad();
      const bound = loaded && admission.attachFrame(controller, loaded);
      if (!bound) {
        controller.retire();
        return;
      }
      const link: Link = {
        load,
        live: false,
        hostClosed: false,
        stateRev: -1,
        handshake: new DocFrameHandshake(bound, {
          nonce: () => crypto.randomUUID(),
          channel: () => new MessageChannel(),
          scheduler: HANDSHAKE_SCHEDULER,
          offline: () => {
            const current = mount.current;
            if (current?.link !== link || link.hostClosed) return;
            // A live page closes its port when it unloads; its next load reconnects.
            // A page that never answered after one did is the case Reload can fix.
            if (!link.live && current.everLive)
              setFailed({ key: current.key, transport: current.transport });
          },
        }),
      };
      m.link = link;
      link.handshake.start();
    } catch {
      // Fail closed: the page stays offline rather than taking the viewer down.
      m.link = null;
      controller.retire();
    } finally {
      attempting.current = false;
    }
  };

  // Reuse the mount for the same navigation (a Suspense reveal keeps its load);
  // anything else starts clean.
  const enter = (ownKey: string, ownTransport: object): Mount => {
    let m = mount.current;
    if (!m || m.key !== ownKey || m.transport !== ownTransport)
      m = mount.current = {
        key: ownKey,
        transport: ownTransport,
        active: false,
        load: null,
        link: null,
        tried: null,
        invalidations: 0,
        everLive: false,
      };
    m.active = true;
    connect();
    return m;
  };
  // A hidden or unmounted view keeps no port.
  const leave = (m: Mount) => {
    m.active = false;
    disconnect(m);
  };

  const ops = useRef({ connect, disconnect, publish, enter, leave });
  useLayoutEffect(() => {
    ops.current = { connect, disconnect, publish, enter, leave };
    latest.current = { params, doc, key, transport };
  });

  useLayoutEffect(() => {
    const m = ops.current.enter(key, transport);
    return () => ops.current.leave(m);
  }, [key, transport]);

  useLayoutEffect(() => {
    const admission = doc.frameAdmission;
    if (!admission) return;
    return admission.subscribeInvalidation(() => {
      const m = mount.current;
      if (attempting.current || !m) return;
      ops.current.disconnect(m);
      m.invalidations++;
    });
  }, [doc.frameAdmission]);

  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const m = mount.current;
      const link = m?.link;
      if (!m || !link || link.hostClosed || !link.handshake.receive(event) || link.live) return;
      link.live = true;
      m.everLive = true;
      setFailed(null);
      ops.current.publish();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  // Runs after every render: picks up a replay, an approved route or new events.
  useLayoutEffect(() => {
    ops.current.connect();
    ops.current.publish();
  });

  const noteFrameLoaded = useCallback((iframe: HTMLIFrameElement) => {
    const m = mount.current;
    const frame = iframe.contentWindow;
    if (!m || !frame || iframe !== latest.current.params.iframeRef.current) return;
    // A new document: the old port goes before the new page can be offered one.
    ops.current.disconnect(m);
    m.load = { frame, delivered: 0 };
    m.tried = null;
    setFailed(null);
    ops.current.connect();
  }, []);

  return {
    requiresReload: failed?.key === key && failed.transport === transport,
    noteFrameLoaded,
  };
}
