/**
 * Relay message bus Transport methods factory.
 *
 * @module shared/lib/transport/relay-methods
 */
import type { AdapterListItem, AdapterEvent, AggregatedDeadLetter } from '@dorkos/shared/transport';
import type {
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  ObservedChat,
} from '@dorkos/shared/relay-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/** Create all Relay methods bound to a base URL. */
export function createRelayMethods(baseUrl: string, getClientId: () => string) {
  return {
    // --- Relay Message Bus ---

    listRelayMessages(filters?: {
      subject?: string;
      status?: string;
      from?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ messages: unknown[]; nextCursor?: string }> {
      const qs = buildQueryString({
        subject: filters?.subject,
        status: filters?.status,
        from: filters?.from,
        cursor: filters?.cursor,
        limit: filters?.limit,
      });
      return fetchJSON(baseUrl, `/relay/messages${qs}`);
    },

    getRelayMessage(id: string): Promise<unknown> {
      return fetchJSON(baseUrl, `/relay/messages/${id}`);
    },

    sendRelayMessage(opts: {
      subject: string;
      payload: unknown;
      from: string;
      replyTo?: string;
    }): Promise<{ messageId: string; deliveredTo: number }> {
      return fetchJSON(baseUrl, '/relay/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    },

    listRelayEndpoints(): Promise<unknown[]> {
      return fetchJSON(baseUrl, '/relay/endpoints');
    },

    registerRelayEndpoint(subject: string): Promise<unknown> {
      return fetchJSON(baseUrl, '/relay/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
      });
    },

    unregisterRelayEndpoint(subject: string): Promise<{ success: boolean }> {
      return fetchJSON(baseUrl, `/relay/endpoints/${subject}`, { method: 'DELETE' });
    },

    readRelayInbox(
      subject: string,
      opts?: { status?: string; cursor?: string; limit?: number },
    ): Promise<{ messages: unknown[]; nextCursor?: string }> {
      const qs = buildQueryString({
        status: opts?.status,
        cursor: opts?.cursor,
        limit: opts?.limit,
      });
      return fetchJSON(baseUrl, `/relay/endpoints/${subject}/inbox${qs}`);
    },

    getRelayMetrics(): Promise<unknown> {
      return fetchJSON(baseUrl, '/relay/metrics');
    },

    listRelayDeadLetters(filters?: { endpointHash?: string }): Promise<unknown[]> {
      const qs = buildQueryString({ endpointHash: filters?.endpointHash });
      return fetchJSON(baseUrl, `/relay/dead-letters${qs}`);
    },

    listAggregatedDeadLetters(): Promise<{ groups: AggregatedDeadLetter[] }> {
      return fetchJSON(baseUrl, '/relay/dead-letters/aggregated');
    },

    dismissDeadLetterGroup(source: string, reason: string): Promise<{ dismissed: number }> {
      return fetchJSON(baseUrl, '/relay/dead-letters', {
        method: 'DELETE',
        body: JSON.stringify({ source, reason }),
      });
    },

    listRelayConversations(): Promise<{ conversations: RelayConversation[] }> {
      return fetchJSON(baseUrl, '/relay/conversations');
    },

    // --- Relay Convergence ---

    async sendMessageRelay(
      sessionId: string,
      content: string,
      options?: { clientId?: string; correlationId?: string; cwd?: string },
    ): Promise<{ messageId: string; traceId: string }> {
      const res = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': options?.clientId ?? getClientId(),
        },
        body: JSON.stringify({
          content,
          ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        }),
      });
      if (res.status !== 202 && !res.ok) {
        const error = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      return res.json();
    },

    getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }> {
      return fetchJSON(baseUrl, `/relay/messages/${messageId}/trace`);
    },

    getRelayDeliveryMetrics(): Promise<DeliveryMetrics> {
      return fetchJSON(baseUrl, '/relay/trace/metrics');
    },

    // --- Relay Adapters ---

    listRelayAdapters(): Promise<AdapterListItem[]> {
      return fetchJSON(baseUrl, '/relay/adapters');
    },

    toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, `/relay/adapters/${id}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      });
    },

    getAdapterCatalog(): Promise<CatalogEntry[]> {
      return fetchJSON(baseUrl, '/relay/adapters/catalog');
    },

    addRelayAdapter(
      type: string,
      id: string,
      config: Record<string, unknown>,
    ): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, '/relay/adapters', {
        method: 'POST',
        body: JSON.stringify({ type, id, config }),
      });
    },

    removeRelayAdapter(id: string): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, `/relay/adapters/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    updateRelayAdapterConfig(
      id: string,
      config: Record<string, unknown>,
    ): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, `/relay/adapters/${encodeURIComponent(id)}/config`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
    },

    testRelayAdapterConnection(
      type: string,
      config: Record<string, unknown>,
    ): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
      return fetchJSON(baseUrl, '/relay/adapters/test', {
        method: 'POST',
        body: JSON.stringify({ type, config }),
      });
    },

    /** Fetch adapter lifecycle events by adapter instance ID. */
    getAdapterEvents(adapterId: string, limit?: number): Promise<{ events: AdapterEvent[] }> {
      const qs = buildQueryString({ limit });
      return fetchJSON(baseUrl, `/relay/adapters/${encodeURIComponent(adapterId)}/events${qs}`);
    },

    /** Get observed chats for an adapter (for chatId picker). */
    getObservedChats(adapterId: string): Promise<ObservedChat[]> {
      return fetchJSON<{ chats: ObservedChat[] }>(
        baseUrl,
        `/relay/adapters/${encodeURIComponent(adapterId)}/chats`,
      ).then((r) => r.chats);
    },

    // --- Relay Bindings ---

    getBindings(): Promise<AdapterBinding[]> {
      return fetchJSON<{ bindings: AdapterBinding[] }>(baseUrl, '/relay/bindings').then(
        (r) => r.bindings,
      );
    },

    createBinding(input: CreateBindingRequest): Promise<AdapterBinding> {
      return fetchJSON<{ binding: AdapterBinding }>(baseUrl, '/relay/bindings', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.binding);
    },

    async deleteBinding(id: string): Promise<void> {
      await fetchJSON<{ ok: boolean }>(baseUrl, `/relay/bindings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    updateBinding(
      id: string,
      updates: Partial<Pick<AdapterBinding, 'sessionStrategy' | 'label' | 'chatId' | 'channelType' | 'canInitiate' | 'canReply' | 'canReceive'>>,
    ): Promise<AdapterBinding> {
      return fetchJSON<{ binding: AdapterBinding }>(baseUrl, `/relay/bindings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }).then((r) => r.binding);
    },
  };
}
