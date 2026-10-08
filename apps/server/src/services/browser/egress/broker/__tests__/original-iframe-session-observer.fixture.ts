import type { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';

type Transport = Parameters<typeof createControllerProxyAuthentication>[0];
type OriginalFrame = Readonly<{ target: string; session: string; parent: string; url: string }>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;

/** Observe genuine SDK child iframe sessions without attaching, querying, or changing forwarding. */
export function observeOriginalSDKIframeSessions(
  original: Transport,
  defaultContext: string,
  originalPageTarget: string,
  current: () => void
) {
  if (!id(defaultContext) || !id(originalPageTarget) || original.onmessage || original.onclose)
    throw new Error('ORIGINAL_IFRAME_OBSERVER_CUSTODY_REQUIRED');
  const open = original.open?.bind(original);
  const send = original.send.bind(original);
  const close = original.close.bind(original);
  const pages = new Set<string>();
  const frames = new Map<string, OriginalFrame>();
  let first: { value: unknown } | undefined;
  let message: Transport['onmessage'];
  let closed: Transport['onclose'];
  const inspect = (packet: unknown) => {
    try {
      if (first || !object(packet) || !object(packet.params)) return;
      const p = packet.params;
      if (packet.method === 'Target.attachedToTarget' && id(p.sessionId) && object(p.targetInfo)) {
        const info = p.targetInfo;
        if (info.browserContextId !== defaultContext || !id(info.targetId)) return;
        if (
          info.type === 'page' &&
          info.targetId === originalPageTarget &&
          !Object.hasOwn(packet, 'sessionId')
        ) {
          if (pages.size >= 16 || pages.has(p.sessionId))
            throw new Error('ORIGINAL_IFRAME_PAGE_SESSION_BOUND');
          pages.add(p.sessionId);
        } else if (info.type === 'iframe' && id(packet.sessionId) && pages.has(packet.sessionId)) {
          if (frames.size >= 64 || frames.has(p.sessionId))
            throw new Error('ORIGINAL_IFRAME_SESSION_BOUND');
          if (typeof info.url !== 'string' || info.url.length > 4096)
            throw new Error('ORIGINAL_IFRAME_URL_BOUND');
          frames.set(
            p.sessionId,
            Object.freeze({
              target: info.targetId,
              session: p.sessionId,
              parent: packet.sessionId,
              url: info.url,
            })
          );
        }
      }
      if (packet.method === 'Target.targetInfoChanged' && object(p.targetInfo)) {
        const info = p.targetInfo;
        for (const [session, frame] of frames) {
          if (info.targetId !== frame.target) continue;
          if (
            info.type !== 'iframe' ||
            info.browserContextId !== defaultContext ||
            typeof info.url !== 'string' ||
            info.url.length > 4096
          )
            throw new Error('ORIGINAL_IFRAME_TARGET_CHANGED');
          frames.set(session, Object.freeze({ ...frame, url: info.url }));
        }
      }
      if (packet.method === 'Target.detachedFromTarget' && id(p.sessionId)) {
        if (!Object.hasOwn(packet, 'sessionId')) pages.delete(p.sessionId);
        const retained = frames.get(p.sessionId);
        if (retained && packet.sessionId === retained.parent) frames.delete(p.sessionId);
      }
    } catch (value) {
      first ??= { value };
    }
  };
  const transport: Transport = {
    open: () => open?.(),
    send,
    close,
    get onmessage() {
      return message;
    },
    set onmessage(value) {
      message = value;
      original.onmessage = value
        ? (packet) => {
            try {
              value(packet);
            } finally {
              inspect(packet);
            }
          }
        : undefined;
    },
    get onclose() {
      return closed;
    },
    set onclose(value) {
      closed = value;
      original.onclose = value
        ? (...args) => {
            try {
              value(...args);
            } finally {
              first ??= { value: new Error('ORIGINAL_IFRAME_WIRE_CLOSED') };
            }
          }
        : undefined;
    },
  };
  return Object.freeze({
    transport,
    requireOriginalFrame(url: string) {
      if (first) throw first.value;
      current();
      const matches = [...frames.values()].filter(
        (frame) => frame.url === url && pages.has(frame.parent)
      );
      if (matches.length !== 1) throw new Error('ORIGINAL_LIVE_OOPIF_SESSION_REQUIRED');
      return matches[0]!;
    },
  });
}
