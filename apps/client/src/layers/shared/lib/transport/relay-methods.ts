/**
 * Relay message bus Transport methods factory.
 *
 * @module shared/lib/transport/relay-methods
 */
import type { AdapterListItem, AdapterEvent, AggregatedDeadLetter } from '@dorkos/shared/transport';
import type {
  RelayDeliveryReceipt,
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  UpdateBindingRequest,
  ObservedChat,
  BindingTestResult,
  UnclaimedChat,
  UnclaimedChatStatus,
  ClaimUnclaimedChatRequest,
  ClaimUnclaimedChatResponse,
} from '@dorkos/shared/relay-schemas';
import { createTransportApiClient } from './api-client';
import { fetchAllPages, fetchJSON, fetchNoContent, buildQueryString } from './http-client';
import { responseError } from '../response-error';

/** Create all Relay methods bound to a base URL. */
export function createRelayMethods(baseUrl: string, getClientId: () => string) {
  const api = createTransportApiClient(baseUrl);
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
    }): Promise<{
      messageId: string;
      deliveredTo: number;
      receipt?: RelayDeliveryReceipt;
      statusUrl?: string;
    }> {
      return fetchJSON(baseUrl, '/relay/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    },

    getRelayDeliveryReceipt(messageId: string): Promise<RelayDeliveryReceipt> {
      return fetchJSON(baseUrl, `/relay/messages/${encodeURIComponent(messageId)}/status`);
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
      opts?: { status?: string; cursor?: string; limit?: number }
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
      options?: { clientId?: string; correlationId?: string; cwd?: string }
    ): Promise<{ messageId: string; traceId: string }> {
      const res = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': options?.clientId ?? getClientId(),
        },
        credentials: 'include',
        body: JSON.stringify({
          content,
          ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        }),
      });
      if (res.status !== 202 && !res.ok) {
        throw await responseError(res);
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

    // The three connection lists come in pages (DOR-4982); these read them whole.
    async listRelayAdapters(): Promise<AdapterListItem[]> {
      type Page = { adapters: AdapterListItem[]; nextCursor: string | null };
      const { rows } = await fetchAllPages(baseUrl, '/relay/adapters', {}, (p: Page) => p.adapters);
      return rows;
    },

    toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, `/relay/adapters/${id}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      });
    },

    async getAdapterCatalog(): Promise<CatalogEntry[]> {
      type Page = { entries: CatalogEntry[]; nextCursor: string | null };
      const path = '/relay/adapters/catalog';
      const { rows } = await fetchAllPages(baseUrl, path, {}, (p: Page) => p.entries);
      return rows;
    },

    addRelayAdapter(
      type: string,
      id: string,
      config: Record<string, unknown>
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

    confirmRelayAdapterReferences(
      id: string,
      fingerprint: string | null
    ): Promise<{ ok: boolean }> {
      const path = `/relay/adapters/${encodeURIComponent(id)}/confirm-references`;
      if (fingerprint === null) return fetchJSON(baseUrl, path, { method: 'DELETE' });
      return fetchJSON(baseUrl, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      });
    },

    updateRelayAdapterConfig(
      id: string,
      config: Record<string, unknown>
    ): Promise<{ ok: boolean }> {
      return fetchJSON(baseUrl, `/relay/adapters/${encodeURIComponent(id)}/config`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
    },

    testRelayAdapterConnection(
      type: string,
      config: Record<string, unknown>
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
        `/relay/adapters/${encodeURIComponent(adapterId)}/chats`
      ).then((r) => r.chats);
    },

    // --- Relay Bindings ---

    async getBindings(): Promise<AdapterBinding[]> {
      type Page = { bindings: AdapterBinding[]; nextCursor: string | null };
      const { rows } = await fetchAllPages(baseUrl, '/relay/bindings', {}, (p: Page) => p.bindings);
      // The server pages newest first; the app has always listed chat routes oldest first.
      return rows.sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
    },

    // Stays hand-written: the API document leaves out its body (DOR-5473).
    createBinding(input: CreateBindingRequest): Promise<AdapterBinding> {
      return fetchJSON<{ binding: AdapterBinding }>(baseUrl, '/relay/bindings', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.binding);
    },

    // Stays hand-written: `DELETE /api/relay/bindings/{id}` has no operationId (DOR-5473).
    async deleteBinding(id: string): Promise<void> {
      await fetchJSON<{ ok: boolean }>(baseUrl, `/relay/bindings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    // Stays hand-written: the API document leaves out its body (DOR-5473).
    updateBinding(id: string, updates: UpdateBindingRequest): Promise<AdapterBinding> {
      return fetchJSON<{ binding: AdapterBinding }>(
        baseUrl,
        `/relay/bindings/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(updates),
        }
      ).then((r) => r.binding);
    },

    // Stays hand-written: `POST /api/relay/bindings/{id}/test` has no operationId (DOR-5473).
    testBinding(bindingId: string): Promise<BindingTestResult> {
      return fetchJSON<BindingTestResult>(
        baseUrl,
        `/relay/bindings/${encodeURIComponent(bindingId)}/test`,
        { method: 'POST' }
      );
    },

    async moveBinding(id: string, agentId: string): Promise<AdapterBinding> {
      const r = (await api.call('relay.moveBindings', { path: { id }, body: { agentId } })) as {
        binding: AdapterBinding;
      };
      return r.binding;
    },

    // --- The claim feed (connection-scoping spec §Part 3) ---

    async listUnclaimedChats(status?: UnclaimedChatStatus): Promise<UnclaimedChat[]> {
      const r = (await api.call('relay.getUnclaimedChats', { query: { status } })) as {
        chats: UnclaimedChat[];
      };
      return r.chats;
    },

    async claimUnclaimedChat(
      id: string,
      input: ClaimUnclaimedChatRequest
    ): Promise<ClaimUnclaimedChatResponse> {
      return (await api.call('relay.claimUnclaimedChats', {
        path: { id },
        body: input,
      })) as ClaimUnclaimedChatResponse;
    },

    async ignoreUnclaimedChat(id: string): Promise<void> {
      await api.call('relay.createUnclaimedChatsIgnore', { path: { id } });
    },

    async blockUnclaimedChat(id: string): Promise<void> {
      await api.call('relay.createUnclaimedChatsBlock', { path: { id } });
    },

    // Stays hand-written: `POST /api/relay/unclaimed-chats/{id}/leave` has no operationId (DOR-5473).
    leaveUnclaimedChat(id: string): Promise<void> {
      return fetchNoContent(baseUrl, `/relay/unclaimed-chats/${encodeURIComponent(id)}/leave`, {
        method: 'POST',
      });
    },
  };
}
