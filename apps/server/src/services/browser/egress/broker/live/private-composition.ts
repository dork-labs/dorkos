import { Server } from 'node:net';
import { createFixtureOriginCustody } from './fixture-origin-custody.js';
import {
  validateEngineConfiguration,
  parseBrowserResult,
  type BrowserBinding,
} from '@dorkos/browser';
import type { Db } from '@dorkos/db';
import type { Auth } from '../../../../core/auth/index.js';
import type { ConfigManager } from '../../../../core/config-manager.js';
import type { createServerInventory } from '../server-inventory.js';
import type { DestinationResolver } from '../../resolution.js';
import {
  createLiveBrowserAuthority,
  type PrivateWorkspaceBrowserGrant,
  type PrivateLiveNetworkPeer,
} from './live-authority.js';
import { createBrokerIssuer } from '../issuer.js';
import { createPreparedPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node-transport.js';
import { BrokerError } from '../errors.js';
import { createLiveBrowserInventory } from './live-inventory.js';
import type { EgressPolicyOptions } from '../../settings.js';
import type { OwnedListener } from '../transport.js';

/** Explicit backend fixture owner. No app mount, download or fixture-network fallback. */
export function createPrivateLiveBrowserComposition(options: {
  scope: 'private-fixture';
  db: Db;
  auth: Auth;
  config: Pick<ConfigManager, 'get' | 'onChange'>;
  inventory: ReturnType<typeof createServerInventory>;
  engineConfiguration: unknown;
  resolver: DestinationResolver;
  now: () => number;
}) {
  if (options.scope !== 'private-fixture') throw new BrokerError('UNAVAILABLE');
  const configuration = validateEngineConfiguration(options.engineConfiguration);
  const network = configuration.network as { kind: string; policyRevision?: number };
  if (
    network.kind !== 'owned' ||
    !Number.isSafeInteger(network.policyRevision) ||
    network.policyRevision! < 0
  )
    throw new BrokerError('AUTHORITY_REFUSED');
  const inventory = createLiveBrowserInventory(options.inventory);
  const peers = new Map<
    PrivateLiveNetworkPeer,
    {
      receiver: Parameters<typeof createPreparedPrivateBroker>[0]['receiver'];
      broker: ReturnType<typeof createPreparedPrivateBroker>;
      listener: OwnedListener;
      sealStarted: boolean;
      policy?: EgressPolicyOptions;
      finalInventoryRevision?: number;
    }
  >();
  const origins = createFixtureOriginCustody();
  const authority = createLiveBrowserAuthority({
    ...options,
    inventory,
    policyRevision: network.policyRevision!,
    checkOwnedOrigins: origins.check,
    readPreparedPolicy(_binding, receiver) {
      const original = [...peers.values()].find((entry) => Object.is(entry.receiver, receiver));
      if (!original) throw new BrokerError('AUTHORITY_REFUSED');
      if (!original.policy) {
        if (original.sealStarted) throw new BrokerError('AUTHORITY_REFUSED');
        original.sealStarted = true;
        inventory.retainBrowserAdmin(original.listener.identity);
        const snapshot = inventory.observe();
        if (!snapshot.policyInputs) throw new BrokerError('AUTHORITY_REFUSED');
        original.finalInventoryRevision = snapshot.inventory.revision;
        original.policy = Object.freeze({
          revision: network.policyRevision!,
          ...snapshot.policyInputs,
          resolver: options.resolver,
        });
      }
      if (inventory.readInventory().revision !== original.finalInventoryRevision)
        throw new BrokerError('AUTHORITY_REFUSED');
      return original.policy;
    },
  });
  const issuer = createBrokerIssuer({ ports: authority.ports, now: options.now });
  const retainedBrokers = new Set<ReturnType<typeof createPreparedPrivateBroker>>();

  return Object.freeze({
    authorizeWorkspace: authority.authorizeWorkspace,
    revokeWorkspace: authority.revokeWorkspace,
    async open(grant: PrivateWorkspaceBrowserGrant, command: unknown) {
      const ownedConfiguration = {
        ...configuration,
        policy: {
          async authorizeAction(
            binding: { browserId: string; browserGeneration: number },
            signal: AbortSignal
          ) {
            if (signal.aborted) return 'refused' as const;
            try {
              authority.authorizeBrowserAction(grant, binding);
              return signal.aborted ? ('refused' as const) : ('allowed' as const);
            } catch {
              return 'refused' as const;
            }
          },
          async verifyBrokerLease() {
            return 'unknown' as const;
          },
        },
      };
      const opened = await authority.openEngine(grant, ownedConfiguration, command, {
        async prepare(context) {
          const receiver = context.receiver as typeof context.receiver & {
            isAuthorityCurrent?: () => boolean;
          };
          if (typeof receiver.isAuthorityCurrent !== 'function')
            throw new BrokerError('AUTHORITY_REFUSED');
          const snapshot = inventory.observe();
          if (!snapshot.policyInputs) throw new BrokerError('AUTHORITY_REFUSED');
          const run = issuer.prepareRun(context.binding, {
            runtimeIdentity: context.runtimeIdentity,
            authorizationEpoch: context.authorizationEpoch,
            policyRevision: context.policyRevision,
            inventoryRevision: snapshot.inventory.revision,
            receiver: receiver as Parameters<typeof createPreparedPrivateBroker>[0]['receiver'],
          });
          let broker: ReturnType<typeof createPreparedPrivateBroker>;
          try {
            broker = createPreparedPrivateBroker({
              issuer,
              run,
              receiver: receiver as Parameters<typeof createPreparedPrivateBroker>[0]['receiver'],
              transport: createNodeBrokerTransport(),
              policy: {
                revision: context.policyRevision,
                ...snapshot.policyInputs,
                resolver: options.resolver,
              },
            });
          } catch (error) {
            issuer.releaseRun(run);
            throw error;
          }
          retainedBrokers.add(broker); // Before first listen; failed intake stays strongly owned.
          try {
            const descriptor = await broker.start();
            const listener = broker.ownedListener();
            if (!listener) throw new BrokerError('AUTHORITY_REFUSED');
            inventory.retainListener(
              listener,
              receiver as typeof receiver & {
                verifiedBrowserAdminEndpoint(): Readonly<{
                  url: string;
                  root: { pid: number; birth: string };
                  supervisor: { pid: number; birth: string };
                }> | null;
              }
            );
            const custody = (broker as typeof broker & { isCustodyKnown?: () => boolean })
              .isCustodyKnown;
            const peer: PrivateLiveNetworkPeer = Object.freeze({
              url: descriptor.server,
              credentials: Object.freeze({ username: 'dorkos', password: descriptor.credential }),
              isCustodyKnown: () =>
                typeof custody === 'function' && Reflect.apply(custody, broker, []) === true,
              async close() {
                if (!(await broker.close())) throw new BrokerError('CLOSED');
                peers.delete(peer);
                retainedBrokers.delete(broker);
              },
            });
            peers.set(peer, {
              receiver: receiver as Parameters<typeof createPreparedPrivateBroker>[0]['receiver'],
              broker,
              listener,
              sealStarted: false,
            });
            return peer;
          } catch (error) {
            try {
              if (await broker.close()) retainedBrokers.delete(broker);
            } catch {
              /* No original-close acknowledgement is invented. */
            }
            throw error;
          }
        },
        async activate(receiver, peer) {
          const original = peers.get(peer);
          if (!original || !Object.is(original.receiver, receiver) || !peer.isCustodyKnown())
            throw new BrokerError('AUTHORITY_REFUSED');
          await original.broker.activate(original.receiver);
          if (!peer.isCustodyKnown()) throw new BrokerError('AUTHORITY_REFUSED');
        },
      });
      return Object.freeze({
        ...opened,
        grantFixtureOrigin(
          original: Server,
          ttl = 10000,
          transport: 'http' | 'websocket' | 'websocket-connect' = 'http'
        ) {
          authority.authorizeOriginal(grant, opened.binding);
          const state = [...peers.values()].find(
            (entry) =>
              entry.receiver.browserId === opened.binding.browserId &&
              entry.receiver.browserGeneration === opened.binding.browserGeneration
          );
          if (!state || !state.broker.isCustodyKnown()) throw new BrokerError('AUTHORITY_REFUSED');
          const url = origins.grant(original, opened.binding, state.broker, ttl, transport);
          authority.authorizeOriginal(grant, opened.binding);
          return url;
        },
        async navigateFixtureOrigin(original: Server, requestId: string) {
          authority.authorizeOriginal(grant, opened.binding);
          const url = origins.url(original, opened.binding);
          const state = [...peers.values()].find(
            (entry) =>
              entry.receiver.browserId === opened.binding.browserId &&
              entry.receiver.browserGeneration === opened.binding.browserGeneration
          );
          const navigate = (
            state?.receiver as
              | (Parameters<typeof createPreparedPrivateBroker>[0]['receiver'] & {
                  navigateInitial?: (command: unknown) => Promise<Readonly<BrowserBinding>>;
                })
              | undefined
          )?.navigateInitial;
          if (!state || typeof navigate !== 'function') throw new BrokerError('AUTHORITY_REFUSED');
          const returned = await (Reflect.apply(navigate, state.receiver, [
            { kind: 'navigate', requestId, binding: opened.opened.tab, url },
          ]) as Promise<Readonly<BrowserBinding>>);
          const result = parseBrowserResult({
            kind: 'action',
            requestId,
            binding: returned,
            outcome: 'completed',
          });
          if (result.kind !== 'action') throw new BrokerError('AUTHORITY_REFUSED');
          authority.authorizeOriginal(grant, opened.binding);
          const current = opened.engine
            .listTabs(opened.binding.browserId, opened.binding.browserGeneration)
            .find((tab) => tab.tabId === result.binding.tabId);
          if (
            !current ||
            (Object.keys(result.binding) as (keyof BrowserBinding)[]).some(
              (key) => current[key] !== result.binding[key]
            )
          ) {
            authority.revokeWorkspace(grant);
            throw new BrokerError('AUTHORITY_REFUSED');
          }
          return result;
        },
        checkProtectedOwnersDenied() {
          authority.authorizeOriginal(grant, opened.binding);
          const entry = [...peers.entries()].find(
            ([, state]) =>
              state.receiver.browserId === opened.binding.browserId &&
              state.receiver.browserGeneration === opened.binding.browserGeneration
          );
          if (!entry) throw new BrokerError('AUTHORITY_REFUSED');
          const [peer, state] = entry;
          const read = (
            state.receiver as typeof state.receiver & {
              verifiedBrowserAdminEndpoint?: () => { url: string } | null;
            }
          ).verifiedBrowserAdminEndpoint;
          const admin =
            typeof read === 'function'
              ? (Reflect.apply(read, state.receiver, []) as { url: string } | null)
              : null;
          if (!admin) throw new BrokerError('AUTHORITY_REFUSED');
          for (const url of [peer.url, admin.url]) {
            try {
              state.broker.grantLocal(url, 'http', 1000);
            } catch (error) {
              if (error instanceof BrokerError && error.code === 'AUTHORITY_REFUSED') continue;
              throw error;
            }
            authority.revokeWorkspace(grant);
            throw new BrokerError('AUTHORITY_REFUSED');
          }
          return true;
        },
        async close() {
          return opened.engine.shutdown();
        },
      });
    },
    stopAdmission: authority.stop,
  });
}
