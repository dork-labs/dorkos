import type { ServerResponse } from 'node:http';

/** Release a slow viewer's bounded frame buffer even when its socket stops draining. */
export function boundViewerResponse(outgoing: ServerResponse): void {
  const finished = () => {
    clearTimeout(timer);
    outgoing.off('finish', finished);
    outgoing.off('close', finished);
  };
  const timer = setTimeout(() => {
    finished();
    outgoing.destroy();
  }, 5_000);
  timer.unref?.();
  outgoing.once('finish', finished);
  outgoing.once('close', finished);
}
