import { vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, WEBHOOK_MANIFEST, type AdapterConfig } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialStore,
} from '../../../core/credential-provider.js';
import { AdapterManager } from '../../adapter-manager.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Shared setup for the DOR-3271 secret-policy tests: an adapter's secret
 * references resolve only for the adapter that owns them, `env:`/`keychain:`
 * only when a person wrote them, removal deletes only the adapter's own
 * entries, and a new address needs its secrets entered again.
 */

vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: vi.fn(async () => {}) }) },
}));

/** An in-memory `file:` store that also holds secrets other parts of DorkOS own. */
export class FakeStore implements CredentialStore {
  readonly secrets = new Map<string, string>([
    ['anthropic', 'sk-ant-THE-REAL-KEY'],
    ['community:space-1:token', 'community-token'],
  ]);
  async put(name: string, secret: string): Promise<string> {
    this.secrets.set(name, secret);
    return `file:${name}`;
  }
  async get(name: string): Promise<string | null> {
    return this.secrets.get(name) ?? null;
  }
  async delete(name: string): Promise<void> {
    this.secrets.delete(name);
  }
}

/** Resolves `file:` from the store and `env:` from a fixed map; records every ask. */
export class FakeProvider implements CredentialProvider {
  readonly asked: string[] = [];
  constructor(private readonly store: FakeStore) {}
  async resolve(ref: string): Promise<CredentialResolution> {
    this.asked.push(ref);
    const [scheme, value] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    const secret =
      scheme === 'file'
        ? await this.store.get(value)
        : scheme === 'env'
          ? ({ ANTHROPIC_API_KEY: 'sk-ant-FROM-ENV' } as Record<string, string>)[value]
          : undefined;
    return secret == null
      ? { ok: false, reason: 'unresolved', ref, message: `nothing at ${scheme}` }
      : { ok: true, secret };
  }
}

export const manifests = new Map<string, AdapterManifest>([['webhook', WEBHOOK_MANIFEST]]);
export const URL_A = 'https://example.com/hook';
export const URL_B = 'https://attacker.example/collect';

/** A disabled webhook entry with the given outbound settings. */
export function webhook(
  id: string,
  outbound: Record<string, unknown>,
  inboundSecret = 'inbound-secret-16chars'
): AdapterConfig {
  return {
    id,
    type: 'webhook',
    enabled: false,
    config: {
      inbound: { subject: `relay.webhook.${id}`, secret: inboundSecret },
      outbound: { url: URL_A, ...outbound },
    },
  } as AdapterConfig;
}

/** A fresh store and provider, and a silenced logger. Call in `beforeEach`. */
export function freshCredentials(): { store: FakeStore; provider: FakeProvider } {
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  const store = new FakeStore();
  return { store, provider: new FakeProvider(store) };
}

/** A manager booted over a real adapters.json. */
export interface Booted {
  file: string;
  registry: AdapterRegistry;
  manager: AdapterManager;
}

const booted: Array<{ manager: AdapterManager; directory?: string }> = [];

/**
 * Boot a manager over an adapters.json holding the built-in plus `entries`, or
 * over an existing `file` when one is given. Call `shutdownBooted` in `afterEach`.
 */
export async function bootManager(
  { store, provider }: { store: FakeStore; provider: FakeProvider },
  entries: unknown[] = [],
  existingFile?: string
): Promise<Booted> {
  let file = existingFile;
  let directory: string | undefined;
  if (!file) {
    directory = await mkdtemp(join(tmpdir(), 'relay-secret-policy-'));
    file = join(directory, 'adapters.json');
    const builtin = {
      id: 'claude-code',
      type: 'claude-code',
      enabled: false,
      builtin: true,
      config: {},
    };
    await writeFile(file, JSON.stringify({ adapters: [builtin, ...entries] }));
  }
  const registry = new AdapterRegistry();
  registry.setRelay({
    publish: vi.fn(async () => ({ messageId: 'fixture', deliveredTo: 1 })),
    subscribe: () => () => {},
    onSignal: () => () => {},
  } as never);
  const manager = new AdapterManager(registry, file, {
    traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
    credentialStore: store,
    credentialProvider: provider,
  });
  booted.push({ manager, directory });
  await manager.initialize();
  await manager.adaptersStarted();
  return { file, registry, manager };
}

/** Shut down every manager `bootManager` started and remove their folders. */
export async function shutdownBooted(): Promise<void> {
  for (const { manager, directory } of booted.splice(0)) {
    await manager.shutdown();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A hand-edited webhook entry whose own secrets are real (put into `store`)
 * and whose Authorization header names `ref`.
 */
export async function handEditedEntry(
  store: FakeStore,
  ref: string,
  extra: Record<string, unknown> = {},
  url = URL_B
): Promise<unknown> {
  await store.put('relay-adapter:wh:outbound.secret', 'own-outbound-secret');
  await store.put('relay-adapter:wh:inbound.secret', 'own-inbound-secret');
  return {
    id: 'wh',
    type: 'webhook',
    enabled: true,
    ...extra,
    config: {
      inbound: { subject: 'relay.webhook.wh', secret: 'file:relay-adapter:wh:inbound.secret' },
      outbound: {
        url,
        secret: 'file:relay-adapter:wh:outbound.secret',
        headers: { Authorization: ref },
      },
    },
  };
}
