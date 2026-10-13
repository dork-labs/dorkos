/** Private authenticated guest client; no host process, environment or credential fallback. */
import { createOpencodeClient, type OpencodeClient, type GlobalEvent } from '@opencode-ai/sdk';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { OPENCODE_OWN_PLAN } from '../credits-sidecar.js';
import { ComputerWire } from './wire.js';
import { readBoundedJson } from './bounded-response.js';

export interface ComputerRuntimeEndpoint {
  opencodeUrl: string;
  opencodePassword: string;
  generation: number;
}
export interface ComputerProviderOptions {
  anchor: string;
  guestDirectory: '/home/agent/project';
  ensureEndpoint(): Promise<ComputerRuntimeEndpoint>;
  currentEnabled(): boolean;
  /** Explicit guest-reachable managed bridge URLs; none permits no managed injection. */
  allowedMcpUrls?: readonly string[];
  mapMcpUrl?(url: string): string | undefined;
  fetch?: typeof globalThis.fetch;
}

/** Owns one generation-fenced guest SDK client and event stream. */
export class ComputerClientProvider implements OpenCodeClientProvider {
  private client: OpencodeClient | null = null;
  private endpoint: ComputerRuntimeEndpoint | undefined;
  private readonly active = new Set<AbortController>();
  readonly wire: ComputerWire;
  constructor(private readonly options: ComputerProviderOptions) {
    this.wire = new ComputerWire(options.anchor, options.guestDirectory);
  }
  private enabled(): void {
    if (!this.options.currentEnabled()) {
      this.invalidate();
      throw new Error('COMPUTER_DISABLED');
    }
  }
  invalidate(): void {
    for (const controller of this.active) controller.abort(new Error('COMPUTER_ENDPOINT_RETIRED'));
    this.active.clear();
    this.client = null;
    this.endpoint = undefined;
  }
  private same(left: ComputerRuntimeEndpoint, right: ComputerRuntimeEndpoint): boolean {
    return (
      left.generation === right.generation &&
      left.opencodeUrl === right.opencodeUrl &&
      left.opencodePassword === right.opencodePassword
    );
  }
  private validate(endpoint: ComputerRuntimeEndpoint): void {
    const url = new URL(endpoint.opencodeUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(endpoint.generation) ||
      endpoint.generation < 1 ||
      endpoint.opencodePassword.length < 16
    )
      throw new Error('COMPUTER_ENDPOINT_REFUSED');
  }
  async getClient(cwd: string): Promise<OpencodeClient> {
    this.enabled();
    this.wire.toGuest(cwd);
    const endpoint = await this.options.ensureEndpoint();
    this.enabled();
    this.validate(endpoint);
    if (this.endpoint && endpoint.generation < this.endpoint.generation)
      throw new Error('COMPUTER_ENDPOINT_RETIRED');
    if (!this.endpoint || !this.same(this.endpoint, endpoint)) {
      this.invalidate();
      this.endpoint = { ...endpoint };
      this.client = this.createClient(this.endpoint);
    }
    return this.client!;
  }
  /** Current owned client generation for the separately fenced bridge. */
  currentGeneration(): number | undefined {
    return this.endpoint?.generation;
  }
  peekClient(): OpencodeClient | null {
    if (!this.options.currentEnabled()) {
      this.invalidate();
      return null;
    }
    return this.client;
  }
  async prepareTurn(): Promise<typeof OPENCODE_OWN_PLAN> {
    this.enabled();
    await this.getClient(this.options.anchor);
    return OPENCODE_OWN_PLAN;
  }
  private async current(endpoint: ComputerRuntimeEndpoint): Promise<void> {
    this.enabled();
    if (!this.endpoint || !this.same(this.endpoint, endpoint))
      throw new Error('COMPUTER_ENDPOINT_RETIRED');
    const observed = await this.options.ensureEndpoint();
    this.enabled();
    if (!this.same(observed, endpoint)) {
      this.invalidate();
      throw new Error('COMPUTER_ENDPOINT_RETIRED');
    }
  }
  private createClient(endpoint: ComputerRuntimeEndpoint): OpencodeClient {
    const fetchRequest = async (request: Request): Promise<Response> => {
      await this.current(endpoint);
      const url = new URL(request.url);
      if (url.origin !== new URL(endpoint.opencodeUrl).origin)
        throw new Error('COMPUTER_ENDPOINT_REFUSED');
      const translated = await this.wire.request(
        request,
        this.options.allowedMcpUrls ?? [],
        this.options.mapMcpUrl,
        endpoint.generation
      );
      translated.headers.set(
        'Authorization',
        `Basic ${Buffer.from(`opencode:${endpoint.opencodePassword}`).toString('base64')}`
      );
      const controller = new AbortController();
      this.active.add(controller);
      const signal = AbortSignal.any([
        translated.signal,
        controller.signal,
        AbortSignal.timeout(30_000),
      ]);
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(
          new Request(translated, { signal, redirect: 'error' })
        );
        await this.current(endpoint);
        if (!response.headers.get('content-type')?.includes('application/json')) return response;
        const json = await readBoundedJson(response);
        await this.current(endpoint);
        const value = this.wire.response(url.pathname, json);
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(JSON.stringify(value), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } finally {
        this.active.delete(controller);
      }
    };
    const client = createOpencodeClient({
      baseUrl: endpoint.opencodeUrl,
      fetch: fetchRequest,
      headers: { 'x-opencode-directory': this.options.anchor },
    });
    // SDK SSE uses global fetch instead of its configured fetch. Own this one stream explicitly.
    client.global.event = async (options) =>
      ({
        stream: this.events(endpoint, options?.signal ?? undefined),
      }) as Awaited<ReturnType<OpencodeClient['global']['event']>>;
    return client;
  }
  private async *events(
    endpoint: ComputerRuntimeEndpoint,
    signal?: AbortSignal
  ): AsyncGenerator<GlobalEvent> {
    await this.current(endpoint);
    const controller = new AbortController();
    this.active.add(controller);
    const fence = setInterval(() => {
      void this.current(endpoint).catch((error: unknown) => controller.abort(error));
    }, 250);
    fence.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `${endpoint.opencodeUrl.replace(/\/$/, '')}/global/event`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${endpoint.opencodePassword}`).toString('base64')}`,
            'x-opencode-directory': this.options.guestDirectory,
            Accept: 'text/event-stream',
          },
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          redirect: 'error',
        }
      );
      if (!response.ok || !response.body) throw new Error('COMPUTER_STREAM_LOST');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 1024 * 1024) throw new Error('COMPUTER_EVENT_LIMIT');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          await this.current(endpoint);
          yield this.wire.event(JSON.parse(data)) as GlobalEvent;
        }
      }
    } finally {
      clearInterval(fence);
      this.active.delete(controller);
      await reader?.cancel().catch(() => {});
    }
  }
}
