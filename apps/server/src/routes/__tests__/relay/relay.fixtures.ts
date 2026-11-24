/**
 * Shared fakes for the Relay route tests: a mocked bus, a mocked adapter
 * manager, one swappable listener per test file, and the real config manager
 * in its default login-off posture.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { RelayCore, AdapterRegistry, WebhookAdapter } from '@dorkos/relay';
import { relayRoutesListener } from '../relay-routes-listener.js';
import type { TraceStore } from '../../../services/relay/trace-store.js';
import type { ActivityService } from '../../../services/activity/activity-service.js';
import type { AdapterManager } from '../../../services/relay/adapter-manager.js';
import { initConfigManager } from '../../../services/core/config-manager.js';

/**
 * ONE listener per test file, with the app behind it swapped per test
 * (DOR-483), so a pooled keep-alive socket never reaches another test's app.
 */
export const target = swappableServer();
/** The listening server every request in a file goes to. */
export const server = target.server;

/** Run the file against the real config manager, login off (the default). */
export function useLoginOffConfig(): void {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dorkos-relay-routes-'));
    initConfigManager(home);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
}

/** A Relay bus whose every method is a spy with a quiet default. */
export function createMockRelayCore(): RelayCore {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    listMessages: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getMessage: vi.fn().mockReturnValue(null),
    getMessageDetail: vi.fn().mockReturnValue(null),
    listEndpoints: vi.fn().mockReturnValue([]),
    registerEndpoint: vi.fn().mockResolvedValue({
      subject: 'relay.test.endpoint',
      hash: 'abc123',
      maildirPath: '/tmp/maildir/abc123',
    }),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
    readInbox: vi.fn().mockReturnValue({ messages: [], nextCursor: undefined }),
    getDeadLetters: vi.fn().mockResolvedValue([]),
    getMetrics: vi.fn().mockReturnValue({ totalMessages: 0, byStatus: {}, bySubject: [] }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RelayCore;
}

/** The Relay routes behind the real `/api` chain, as `http/hono-api.ts` mounts them. */
export function relayApp(
  relayCore: RelayCore,
  adapterManager?: AdapterManager,
  traceStore?: TraceStore,
  activity?: ActivityService
) {
  return relayRoutesListener({ relayCore, adapterManager, traceStore, activity });
}

const TELEGRAM = {
  config: {
    id: 'tg-main',
    type: 'telegram',
    enabled: true,
    config: { token: 'x', mode: 'polling' },
  },
  status: { state: 'connected', messageCount: { inbound: 10, outbound: 5 }, errorCount: 0 },
};

const WEBHOOK = {
  config: {
    id: 'wh-github',
    type: 'webhook',
    enabled: true,
    config: {
      inbound: { subject: 'relay.webhook.github', secret: 'a-very-long-secret-16' },
      outbound: { url: 'https://example.com/hook', secret: 'another-long-secret-16' },
    },
  },
  status: { state: 'connected', messageCount: { inbound: 5, outbound: 3 }, errorCount: 0 },
};

/** A mock AdapterManager holding one Telegram and one webhook connection. */
export type MockAdapterManager = AdapterManager & { _mockWebhookAdapter: WebhookAdapter };

/** Create a mock AdapterManager for route testing. */
export function createMockAdapterManager(): MockAdapterManager {
  const mockWebhookAdapter = {
    id: 'wh-github',
    subjectPrefix: 'relay.webhook.github',
    displayName: 'Webhook (wh-github)',
    start: vi.fn(),
    stop: vi.fn(),
    deliver: vi.fn(),
    getStatus: vi.fn().mockReturnValue(WEBHOOK.status),
    handleInbound: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as WebhookAdapter;

  const mockRegistry = {
    get: vi.fn((id: string) => (id === 'wh-github' ? mockWebhookAdapter : undefined)),
  } as unknown as AdapterRegistry;

  return {
    listAdapters: vi.fn().mockReturnValue([TELEGRAM, WEBHOOK]),
    getAdapter: vi.fn((id: string) =>
      id === 'tg-main' ? TELEGRAM : id === 'wh-github' ? WEBHOOK : undefined
    ),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    getRegistry: vi.fn().mockReturnValue(mockRegistry),
    getCatalog: vi.fn().mockReturnValue([
      {
        manifest: {
          type: 'telegram',
          displayName: 'Telegram',
          description: 'Telegram bot adapter',
          category: 'messaging',
          builtin: true,
          configFields: [],
        },
        instances: [TELEGRAM],
      },
    ]),
    addAdapter: vi.fn().mockResolvedValue(undefined),
    removeAdapter: vi.fn().mockResolvedValue(undefined),
    confirmReferences: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    resolveAdapterName: vi.fn((id: string) => id),
    getBindingStore: vi.fn().mockReturnValue(undefined),
    getBindingRouter: vi.fn().mockReturnValue(undefined),
    getMeshCore: vi.fn().mockReturnValue(undefined),
    _mockWebhookAdapter: mockWebhookAdapter,
  } as unknown as MockAdapterManager;
}
