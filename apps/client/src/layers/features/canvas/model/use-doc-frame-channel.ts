/** Mount the original replay-issued frame port across one real iframe navigation. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTransport } from '@/layers/shared/model';
import {
  FrameLifetimeController,
  DocFrameHandshake,
  type FrameObservation,
} from '@/layers/shared/lib/canvas-doc-frame';
import { useDocChannel } from './use-doc-channel';
import type { NativeFrameAdmission } from './doc-channel-view';

export interface DocFrameMountParams {
  /** Host browser mounts a genuinely fresh blank node before original source assignment. */
  freshPhysicalFrame?: boolean;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  documentId: string;
  logicalUrl: string;
  reloadNonce: number;
  resolvedSource: string | null;
  bridgeEligibility: 'served-document' | 'preview-listener' | null;
  previewOrigin: string | null;
}
type LoadCapture = {
  element: HTMLIFrameElement;
  key: string;
  frame: Window;
  admission: NativeFrameAdmission;
  completeLoad(): FrameObservation | null;
};
/** Content stays mounted on revocation; only an explicit navigation can acquire another load. */
export function useDocFrameChannel(params: DocFrameMountParams) {
  const transport = useTransport();
  const doc = useDocChannel(params.documentId);
  const [controller] = useState(() => new FrameLifetimeController());
  const [navigation, setNavigation] = useState<{ key: string; transport: object } | null>(null);
  const [blankLoaded, setBlankLoaded] = useState<{ key: string; frame: Window } | null>(null);
  const consumedMountElements = useRef(new WeakSet<HTMLIFrameElement>());
  const [preparationFailure, setPreparationFailure] = useState<{ cause: unknown } | null>(null);
  const pendingPreparation = useRef<{ live: boolean } | null>(null);
  const freshMount = useRef<{
    element: HTMLIFrameElement;
    frame: Window;
    key: string;
    transport: object;
  } | null>(null);
  const frontier = useRef({
    phase: 'before-navigation',
    messages: 0,
    accepted: 0,
    prepared: 0,
    retiredPending: 0,
    capturePresent: false,
    keyMatches: false,
    windowMatches: false,
    admissionMatches: false,
  });
  const recordFrontier = (phase: string) => {
    frontier.current.phase = phase;
    current.current.params.iframeRef.current?.setAttribute(
      'data-original-doc-handshake-frontier',
      JSON.stringify({
        ...frontier.current,
        readCurrent: current.current.doc.channel.current?.('read') === true,
        blankKeyMatches: blankLoaded?.key === current.current.key,
        blankFrameMatches:
          blankLoaded?.frame === current.current.params.iframeRef.current?.contentWindow,
        replayObserved: current.current.doc.replayObserved === true,
        frameAdmissionPresent: !!current.current.doc.frameAdmission,
      })
    );
  };
  const load = useRef<LoadCapture | null>(null);
  const loaded = useRef<{
    key: string;
    frame: Window;
    transport: object;
    epoch: number;
    admission: NativeFrameAdmission;
    observation: FrameObservation;
  } | null>(null);
  const handshake = useRef<DocFrameHandshake | null>(null);
  const connected = useRef(false);
  const epoch = useRef(0);
  const sent = useRef({ high: 0, revision: -1 });
  const key = JSON.stringify([
    params.documentId,
    params.logicalUrl,
    params.resolvedSource,
    params.reloadNonce,
    ...(params.freshPhysicalFrame ? [params.bridgeEligibility, params.previewOrigin] : []),
  ]);
  const eligible = !!params.resolvedSource && !!params.bridgeEligibility;
  // This key is only React mount mechanics, never a channel credential or DOM attribute.
  const physicalMountKey = useMemo(() => crypto.randomUUID(), [key, transport]);
  const noteFrameMounted = useCallback(
    (element: HTMLIFrameElement | null) => {
      if (
        !params.freshPhysicalFrame ||
        !element ||
        !element.isConnected ||
        element !== params.iframeRef.current ||
        consumedMountElements.current.has(element)
      )
        return;
      consumedMountElements.current.add(element);
      const frame = element.contentWindow;
      if (frame) freshMount.current = { element, frame, key, transport };
    },
    [params.freshPhysicalFrame, params.iframeRef, key, transport]
  );
  const current = useRef({ params, doc, key, transport, eligible });
  const close = () => {
    const old = handshake.current;
    handshake.current = null;
    connected.current = false;
    sent.current = { high: 0, revision: -1 };
    old?.close();
    if (old) recordFrontier('closed-original-handshake');
  };
  const retire = () => {
    if (pendingPreparation.current) pendingPreparation.current.live = false;
    pendingPreparation.current = null;
    if (load.current) frontier.current.retiredPending++;
    load.current = null;
    loaded.current = null;
    epoch.current++;
    let failed = false;
    let first: unknown;
    try {
      controller.retire();
    } catch (cause) {
      failed = true;
      first = cause;
    }
    try {
      close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  };
  const publish = () => {
    const own = current.current.doc;
    const port = handshake.current;
    if (!port || !connected.current || !own.channel.current?.('read') || !own.snapshot) return;
    port.publish({ kind: 'status', status: 'ready', unconfirmed: false });
    for (const frame of own.events) {
      if (frame.docSeq <= sent.current.high) continue;
      port.publish({ kind: 'event', frame });
      sent.current.high = frame.docSeq;
    }
    if (own.snapshot.stateRev > sent.current.revision) {
      port.publish({
        kind: 'state',
        state: own.snapshot.state,
        stateRev: own.snapshot.stateRev,
        docSeq: own.snapshot.highWatermark,
        reset: own.snapshot.resetRequired,
      });
      sent.current.revision = own.snapshot.stateRev;
    }
  };
  const connectLoaded = () => {
    const completed = loaded.current;
    const own = current.current;
    const iframe = own.params.iframeRef.current;
    if (!completed || handshake.current || !own.doc.channel.current?.('read')) return;
    if (
      completed.key !== own.key ||
      completed.transport !== own.transport ||
      completed.epoch !== epoch.current ||
      completed.frame !== iframe?.contentWindow ||
      completed.admission !== own.doc.frameAdmission ||
      controller.getCurrent() !== completed.observation ||
      !completed.admission.retainsLoadedFrame(controller, completed.observation)
    ) {
      retire();
      return;
    }
    const bound = completed.admission.attachFrame(controller, completed.observation);
    if (!bound) {
      recordFrontier('original-port-attach-refused');
      if (loaded.current === completed) retire();
      return;
    }
    if (
      loaded.current !== completed ||
      current.current.key !== completed.key ||
      current.current.transport !== completed.transport ||
      epoch.current !== completed.epoch ||
      current.current.doc.frameAdmission !== completed.admission ||
      current.current.params.iframeRef.current?.contentWindow !== completed.frame ||
      !current.current.doc.channel.current?.('read') ||
      !bound.current() ||
      !completed.admission.retainsLoadedFrame(controller, completed.observation)
    ) {
      controller.retireDoc(bound.binding);
      return;
    }
    const next = new DocFrameHandshake(bound, {
      nonce: () => crypto.randomUUID(),
      channel: () => new MessageChannel(),
      scheduler: {
        random: () => Math.random(),
        schedule: (callback, delay) => setTimeout(callback, delay),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      offline: () => {
        connected.current = false;
        recordFrontier('original-handshake-offline');
      },
    });
    handshake.current = next;
    recordFrontier('starting-original-handshake');
    next.start();
  };
  const methods = useRef({ retire, publish, connectLoaded });
  methods.current = { retire, publish, connectLoaded };
  useLayoutEffect(() => {
    current.current = { params, doc, key, transport, eligible };
  });
  // One original physical navigation. A later same-URL replay cannot relabel its load.
  const prepareNavigation = () => {
    const element = params.iframeRef.current;
    const frame = element?.contentWindow;
    if (
      !eligible ||
      !element ||
      !frame ||
      (navigation?.key === key && navigation.transport === transport)
    )
      return;
    if (params.freshPhysicalFrame) {
      // Initial blank insertion fires synchronously, before ref registration.
      // The private fresh node supplies only unloaded host context: no synthetic
      // blank-loaded witness or Doc authority. Capture precedes the sole real src assignment.
      const mount = freshMount.current;
      if (
        !mount ||
        mount.element !== element ||
        mount.frame !== frame ||
        mount.key !== key ||
        mount.transport !== transport
      ) {
        recordFrontier('original-fresh-mount-refused');
        return;
      }
    } else {
      // Chromium's initial empty document can already be complete without firing
      // a load event. Observe only this host-readable blank document; it cannot
      // complete or attach the subsequently captured original Doc load.
      if (blankLoaded?.key !== key || blankLoaded.frame !== frame) {
        recordFrontier('awaiting-original-blank-load');
        const iframe = params.iframeRef.current;
        try {
          const blank = iframe?.contentDocument;
          if (
            iframe?.getAttribute('src') === 'about:blank' &&
            blank?.URL === 'about:blank' &&
            blank.readyState === 'complete' &&
            iframe.contentWindow === frame
          )
            setBlankLoaded({ key, frame });
        } catch {
          // Opaque blank frames retain the original browser load-event path.
        }
        return;
      }
    }
    if (!doc.replayObserved) {
      recordFrontier('awaiting-original-replay');
      return;
    }
    if (!doc.channel.current?.('read') || !doc.frameAdmission) {
      // Legacy/refused replay still displays the page with its SDK offline.
      recordFrontier('replay-display-without-original-read');
      setNavigation({ key, transport });
      return;
    }
    const observation = controller.observeHostContext({
      frame,
      documentId: params.documentId,
      resolvedSource: params.resolvedSource,
      logicalUrl: params.logicalUrl,
      reloadKey: String(params.reloadNonce),
      sessionId: null,
      eligibility: params.bridgeEligibility,
      exactOrigin: params.bridgeEligibility === 'served-document' ? 'null' : params.previewOrigin,
      transportOwner: transport,
      publisherEpoch: epoch.current,
    });
    if (!observation) {
      recordFrontier('original-host-observation-refused');
      return;
    }
    const prepared = doc.frameAdmission.prepareFrameLoad(controller, observation);
    if (!prepared) {
      recordFrontier('original-load-preparation-refused');
      return;
    }
    if (
      params.freshPhysicalFrame &&
      (current.current.key !== key ||
        current.current.transport !== transport ||
        current.current.doc.frameAdmission !== doc.frameAdmission ||
        !current.current.doc.channel.current?.('read') ||
        current.current.params.iframeRef.current !== element ||
        element.contentWindow !== frame ||
        controller.getCurrent() !== observation)
    ) {
      // Preparation may synchronously notify retirement/replacement subscribers.
      // Never install their retired capture or assign its real source afterwards.
      recordFrontier('original-fresh-preparation-retired');
      methods.current.retire();
      return;
    }
    load.current = {
      element,
      key,
      frame,
      admission: doc.frameAdmission,
      completeLoad: prepared.completeLoad,
    };
    frontier.current.prepared++;
    recordFrontier('prepared-original-load');
    setNavigation({ key, transport });
  };
  useLayoutEffect(() => {
    if (!params.freshPhysicalFrame) prepareNavigation();
  });
  useEffect(() => {
    if (!params.freshPhysicalFrame) return;
    // Layout retirement and StrictMode's synchronous cleanup finish before the
    // live microtask prepares this still-blank node and assigns its sole real src.
    // Cleanup/revocation cancels private work; no timer, retry or synthetic load.
    const token = { live: true };
    pendingPreparation.current = token;
    queueMicrotask(() => {
      if (!token.live || pendingPreparation.current !== token) return;
      try {
        prepareNavigation();
      } catch (cause) {
        // Preserve the actual preparation failure for the original React boundary.
        setPreparationFailure({ cause });
      } finally {
        if (pendingPreparation.current === token) pendingPreparation.current = null;
      }
    });
    return () => {
      token.live = false;
      if (pendingPreparation.current === token) pendingPreparation.current = null;
    };
  });
  useLayoutEffect(() => {
    const admission = doc.frameAdmission;
    if (!admission) return;
    return admission.subscribeInvalidation(() => {
      // The facade also drains an old provisional port when starting its next
      // original load/attach. Only actual owner retirement retires host facts.
      const latest = current.current.doc;
      // This subscriber belongs to the captured original facade. Qualification
      // may replace its projected channel without replacing that facade; a
      // different owner's current channel can never preserve this old load.
      const completed = loaded.current;
      if (
        latest.frameAdmission === admission &&
        (latest.channel.current?.('read') ||
          (completed?.admission === admission &&
            admission.retainsLoadedFrame(controller, completed.observation)))
      ) {
        close();
        controller.disableDoc();
      } else methods.current.retire();
    });
  }, [doc.frameAdmission]);
  useLayoutEffect(() => {
    return () => methods.current.retire();
  }, [key, transport]);
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const own = handshake.current;
      if (own) {
        frontier.current.messages++;
        recordFrontier('received-window-message');
      }
      if (own?.receive(event) && handshake.current === own) {
        frontier.current.accepted++;
        recordFrontier('accepted-original-ack');
        connected.current = true;
        methods.current.publish();
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useLayoutEffect(() => {
    methods.current.connectLoaded();
    methods.current.publish();
  });
  const noteFrameLoaded = useCallback(
    (iframe: HTMLIFrameElement): boolean => {
      const own = current.current;
      if (iframe !== own.params.iframeRef.current) return false;
      // The initial blank frame isn't the host load captured before navigation.
      if (iframe.getAttribute('src') === 'about:blank') {
        // Fresh-node mode never uses a blank event as a load or authority witness.
        if (!own.params.freshPhysicalFrame) {
          const frame = iframe.contentWindow;
          if (frame) setBlankLoaded({ key: own.key, frame });
        }
        return false;
      }
      // A queued initial blank load can arrive after React assigned the real
      // source. Its still-blank document never consumes that source's load.
      try {
        if (iframe.contentDocument?.URL === 'about:blank') return false;
      } catch {
        // A real cross-origin/opaque document is not host-readable.
      }
      const captured = load.current;
      frontier.current.capturePresent = !!captured;
      frontier.current.keyMatches = captured?.key === own.key;
      frontier.current.windowMatches = captured?.frame === iframe.contentWindow;
      frontier.current.admissionMatches = captured?.admission === own.doc.frameAdmission;
      load.current = null;
      if (
        !captured ||
        captured.element !== iframe ||
        captured.key !== own.key ||
        captured.frame !== iframe.contentWindow ||
        captured.admission !== own.doc.frameAdmission
      ) {
        recordFrontier('original-load-capture-refused');
        methods.current.retire();
        return true;
      }
      recordFrontier('consuming-original-load');
      const observation = captured.completeLoad();
      if (!observation) {
        recordFrontier('original-load-completion-refused');
        methods.current.retire();
        return true;
      }
      loaded.current = {
        key: own.key,
        frame: captured.frame,
        transport: own.transport,
        epoch: epoch.current,
        admission: captured.admission,
        observation,
      };
      methods.current.connectLoaded();
      return true;
    },
    [controller]
  );
  const noteFrameRetired = useCallback(() => methods.current.retire(), []);
  if (preparationFailure) throw preparationFailure.cause;
  return {
    physicalMountKey,
    noteFrameMounted,
    noteFrameLoaded,
    noteFrameRetired,
    navigationSource:
      eligible && !(navigation?.key === key && navigation.transport === transport)
        ? 'about:blank'
        : params.resolvedSource,
  };
}
