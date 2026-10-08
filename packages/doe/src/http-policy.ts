/** Confine explicit requests to the supplied HTTP endpoint; never forward credentials through redirects. */
export function confinedFetch(endpoint: string, onStatus: (status: number) => void): typeof fetch {
  const configured = new URL(endpoint);
  return async (input, init) => {
    const target = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (
      target.origin !== configured.origin ||
      !target.pathname.startsWith(configured.pathname.replace(/\/$/, '') + '/')
    )
      throw new Error('Request left the configured endpoint');
    const response = await globalThis.fetch(input, { ...init, redirect: 'manual' });
    onStatus(response.status);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Endpoint redirects refused');
    }
    return response;
  };
}
