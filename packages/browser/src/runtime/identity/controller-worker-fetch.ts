type Params = Record<string, unknown>;
const record = (value: unknown): value is Params =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Bounded state for the exact admitted SDK worker's Fetch owner; no protocol producers. */
export function createControllerWorkerFetch() {
  const routing = new Map<string, Params>();
  const managed = new Set<string>();
  const active = new Set<string>();
  return {
    sdk(session: string, method: 'Fetch.enable' | 'Fetch.disable', value: unknown) {
      managed.delete(session);
      if (method === 'Fetch.disable') {
        routing.delete(session);
        return;
      }
      if (!routing.has(session) && routing.size >= 128)
        throw new Error('CONTROLLER_AUTH_WORKER_ROUTING_CAPACITY');
      const bytes = JSON.stringify(value);
      if (!bytes || Buffer.byteLength(bytes) > 65536)
        throw new Error('CONTROLLER_AUTH_WORKER_ROUTING_INVALID');
      const params: unknown = JSON.parse(bytes);
      if (
        !record(params) ||
        params.handleAuthRequests !== true ||
        (params.patterns !== undefined &&
          (!Array.isArray(params.patterns) ||
            !params.patterns.length ||
            params.patterns.length > 128 ||
            params.patterns.some((pattern) => !record(pattern))))
      )
        throw new Error('CONTROLLER_AUTH_WORKER_ROUTING_INVALID');
      routing.set(session, params);
    },
    setup(session: string): Params {
      const params = routing.get(session);
      if (params) return params;
      managed.add(session);
      return { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] };
    },
    owns: (session: string) => managed.has(session),
    begin(session: string, request: string) {
      const key = JSON.stringify([session, request]);
      if (active.has(key)) throw new Error('CONTROLLER_AUTH_WORKER_REQUEST_REPEATED');
      if (active.size >= 128) throw new Error('CONTROLLER_AUTH_WORKER_REQUEST_CAPACITY');
      active.add(key);
      return () => {
        active.delete(key);
      };
    },
    detach(session: string) {
      routing.delete(session);
      managed.delete(session);
    },
  };
}
