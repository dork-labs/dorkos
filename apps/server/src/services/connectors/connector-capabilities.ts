/**
 * The connector domain's capabilities (connector-completion spec §Detailed
 * Design 2) — the seven agent-facing tools that make "connect my Gmail" work
 * from inside a chat, projected onto BOTH MCP servers by the capability
 * registry exactly as the marketplace domain is.
 *
 * Every capability is a thin wrapper over the shipped connector services and
 * never bypasses the REST routes' invariants: the public account shape comes
 * from `public-account.ts`, the in-flight flow → provider bindings are the
 * SHARED {@link ConnectorFlowBindings} instance the REST router uses (a flow
 * started in chat can be polled over REST and vice versa), and a successful
 * poll records the account via `registry.recordConnect` exactly as the route
 * does.
 *
 * Consent semantics (spec §Decisions 3): the three reads carry
 * `readOnlyCarveOut: true`; `connector.attach_account` is the consent binding,
 * so it is a `destructive`-tier mutation — the tier gate asks a person before
 * an agent can grant itself a user's account. `start_connect` returns markdown
 * carrying the sign-in URL and the custody disclosure verbatim — the v1
 * in-chat connect experience (a custom card is a named deferred enhancement,
 * spec §Non-Goals).
 *
 * Session scoping: in-session invocations default to the invoking session
 * (`context.sessionId`, set by the in-session adapter); external `/mcp`
 * callers have no invoking session and must pass `sessionId` explicitly.
 *
 * @module services/connectors/connector-capabilities
 */
import { z } from 'zod';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';

import { defineCapability, type CapabilityDomain } from '../core/capabilities/index.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { custodyDisclosure } from './custody-disclosure.js';
import { recommendConnector, type RelayAdapterCatalog } from './routing.js';
import { toPublicAccount } from './public-account.js';
import type { ConnectorFlowBindings } from './flow-bindings.js';
import type { ConnectorRegistry } from './registry.js';
import type { SessionConnectorService } from './session-exposure.js';

/** The connector service bundle the capabilities read. */
export interface ConnectorCapabilityDeps {
  /** The registry holding the connector backends + id → provider routing. */
  registry: ConnectorRegistry;
  /** The per-account → session tool-server binder (attach/detach). */
  sessionConnectors: SessionConnectorService;
  /** The SHARED in-flight flow → provider map (same instance as the REST router). */
  flowBindings: ConnectorFlowBindings;
  /** Optional relay adapter catalog for relay-adapter-first routing. */
  relay?: RelayAdapterCatalog;
}

/**
 * Extend the shared dependency bag with the connector domain's service bundle.
 * Optional so a registry composed from other domains alone need not supply it;
 * every connector `invoke` asserts its presence via
 * {@link requireConnectorDeps}.
 */
declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Connector service bundle consumed by the connector capabilities. */
    connectorDeps?: ConnectorCapabilityDeps;
  }
}

/**
 * Narrow the shared bag to the connector service bundle, throwing if a registry
 * that owns connector capabilities was composed without it (a wiring bug).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The connector service bundle.
 */
function requireConnectorDeps(deps: CapabilityDeps): ConnectorCapabilityDeps {
  if (!deps.connectorDeps) {
    throw new Error('Connector capability invoked without connectorDeps in the registry bag.');
  }
  return deps.connectorDeps;
}

/**
 * Resolve the session a session-scoped capability acts on: the explicit
 * `sessionId` input when given, otherwise the invoking session (in-session
 * calls). External `/mcp` callers have neither and get a clear error.
 *
 * @param inputSessionId - The optional `sessionId` the caller passed.
 * @param context - The handler context (carries the invoking session in-session).
 */
function resolveSessionId(
  inputSessionId: string | undefined,
  context: CapabilityHandlerContext
): string {
  const sessionId = inputSessionId ?? context.sessionId;
  if (!sessionId) {
    throw new CapabilityToolError({
      error:
        'No session to act on. In a DorkOS session this defaults to the current one; ' +
        'external callers must pass sessionId explicitly.',
    });
  }
  return sessionId;
}

/** Shared `{ accountId, sessionId? }` input for attach/detach. */
const SessionAccountInputSchema = z.object({
  accountId: z.string().min(1).describe('The connected account id (from connector_list_accounts).'),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Target session id. Defaults to the invoking session; required for external callers.'
    ),
});

/**
 * The connector domain: read-only discovery first, then the connect flow, then
 * the session attach/detach mutations. This is the registration order on both
 * MCP servers.
 */
export const connectorDomain: CapabilityDomain = {
  name: 'connector',
  assertDeps: requireConnectorDeps,
  capabilities: [
    // ── Read-only discovery ─────────────────────────────────────────────────
    defineCapability({
      id: 'connector.list_toolkits',
      title: 'List connectable services',
      description:
        'List the services (Gmail, Slack, …) the configured connector backends can connect, ' +
        'aggregated and deduped. Empty when no connector provider is configured yet — point the ' +
        'user at Settings → Connections to add a provider key.',
      tier: 'observe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_list_toolkits',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps) => {
        const { registry } = requireConnectorDeps(deps);
        return registry.listToolkits();
      },
    }),
    defineCapability({
      id: 'connector.recommend',
      title: 'Recommend how to connect a service',
      description:
        'Recommend how to connect a named service, best route first: a purpose-built relay ' +
        'adapter outranks a gateway connector, which outranks a raw MCP server. Call this before ' +
        'the start-connecting tool when the user asks to connect something.',
      tier: 'observe',
      input: z.object({
        service: z.string().min(1).describe("Service slug, e.g. 'gmail' or 'slack'."),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_recommend',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { registry, relay } = requireConnectorDeps(deps);
        return recommendConnector(input.service, { registry, ...(relay && { relay }) });
      },
    }),
    defineCapability({
      id: 'connector.list_accounts',
      title: 'List connected accounts',
      description:
        'List the accounts the user has connected (optionally filtered to one service), each ' +
        'with its status and its plain-language custody line. Pass the account id to the ' +
        'attach-account tool to expose its tools to a session.',
      tier: 'observe',
      input: z.object({
        toolkit: z.string().min(1).optional().describe('Filter to one service slug.'),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_list_accounts',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { registry } = requireConnectorDeps(deps);
        const { accounts, warnings } = await registry.listAccounts(
          input.toolkit ? { toolkit: input.toolkit } : undefined
        );
        // toPublicAccount strips the server-only provider field AND attaches
        // the per-account custody sentence — one shape for routes and agents.
        return { accounts: accounts.map(toPublicAccount), warnings };
      },
    }),

    // ── The connect flow ────────────────────────────────────────────────────
    defineCapability({
      id: 'connector.start_connect',
      title: 'Start connecting a service',
      description:
        'Begin connecting a service account. Returns markdown with the sign-in link and the ' +
        'custody disclosure — show BOTH to the user verbatim, then wait for them to say they ' +
        'have signed in before checking the flow with the poll-connect tool, passing the ' +
        'returned flowId. ' +
        'Pass a label (e.g. "work") to tell two accounts of one service apart.',
      tier: 'act',
      input: z.object({
        service: z.string().min(1).describe("Service slug to connect, e.g. 'gmail'."),
        label: z
          .string()
          .min(1)
          .optional()
          .describe('Disambiguates multiple accounts of one service, e.g. "work".'),
        provider: z
          .string()
          .min(1)
          .optional()
          .describe('Force a specific backend; omitted = best gateway/raw-mcp recommendation.'),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_start_connect',
          servers: ['in-session', 'external'],
          annotations: { openWorldHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { registry, relay, flowBindings } = requireConnectorDeps(deps);

        let providerType = input.provider;
        if (!providerType) {
          // Pick the top gateway/raw-mcp recommendation. A relay-adapter
          // recommendation is deliberately skipped here: it is a different
          // surface, and connector_recommend already points the agent at it.
          const { recommendations } = await recommendConnector(input.service, {
            registry,
            ...(relay && { relay }),
          });
          providerType = recommendations.find(
            (r) => r.kind === 'gateway' || r.kind === 'raw-mcp'
          )?.provider;
        }
        const provider = providerType ? registry.resolveProvider(providerType) : undefined;
        if (!provider) {
          throw new CapabilityToolError({
            error:
              `Nothing can connect '${input.service}' yet. ` +
              'Ask the user to configure a connector provider under Settings → Connections.',
          });
        }

        let start;
        try {
          start = await provider.startConnect(
            input.service,
            input.label ? { label: input.label } : undefined
          );
        } catch (err) {
          // A rejected startConnect (unknown toolkit, duplicate single-account
          // connect) is a domain error the agent should relay, never a crash.
          throw new CapabilityToolError({
            error: err instanceof Error ? err.message : 'Failed to start the connect flow.',
          });
        }
        flowBindings.record(start.flowId, provider.type);

        const disclosure = custodyDisclosure(provider.getCapabilities().custody, {
          service: input.service,
        });
        // The v1 in-chat connect experience: plain markdown the chat renders.
        const message =
          `[Sign in to ${input.service}](${start.authorizeUrl})\n\n` +
          `${disclosure}\n\n` +
          `Tell me when you've signed in, then I'll check.`;
        return { flowId: start.flowId, authorizeUrl: start.authorizeUrl, disclosure, message };
      },
    }),
    defineCapability({
      id: 'connector.poll_connect',
      title: 'Check a connect flow',
      description:
        'Check whether a connect flow the user was sent to sign in for has completed. ' +
        'Returns pending, connected (with the new account), or failed. Call after the user ' +
        'says they have signed in.',
      tier: 'act',
      input: z.object({
        flowId: z.string().min(1).describe('The flow id the start-connecting tool returned.'),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_poll_connect',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { registry, flowBindings } = requireConnectorDeps(deps);
        const providerType = flowBindings.providerFor(input.flowId);
        const provider = providerType ? registry.resolveProvider(providerType) : undefined;
        if (!provider) {
          throw new CapabilityToolError({ error: `Unknown connect flow '${input.flowId}'.` });
        }
        const poll = await provider.pollConnect(input.flowId);
        // Exactly the REST route's bookkeeping: bind the account for routing on
        // success, release the flow binding on any terminal state.
        if (poll.status === 'connected' && poll.account) {
          registry.recordConnect(poll.account);
        }
        if (poll.status === 'connected' || poll.status === 'failed') {
          flowBindings.release(input.flowId);
        }
        return {
          status: poll.status,
          ...(poll.account && { account: toPublicAccount(poll.account) }),
          ...(poll.error && { error: poll.error }),
        };
      },
    }),

    // ── Session attach/detach (the consent binding) ─────────────────────────
    defineCapability({
      id: 'connector.attach_account',
      title: 'Attach an account to a session',
      description:
        "Expose a connected account's tools to a session. This is a consent point: a person " +
        'approves it, and the result echoes the custody disclosure. The tools appear on the ' +
        "session's next turn. Defaults to the current session; external callers must pass " +
        'sessionId.',
      tier: 'destructive',
      input: SessionAccountInputSchema,
      output: z.unknown(),
      // What a person needs to decide: which account, onto which session.
      approvalDisplayFields: ['accountId', 'sessionId'],
      surfaces: {
        mcp: {
          toolName: 'connector_attach_account',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const { sessionConnectors } = requireConnectorDeps(deps);
        const sessionId = resolveSessionId(input.sessionId, context);
        const result = await sessionConnectors.attach(
          sessionId,
          input.accountId as ConnectedAccountId
        );
        if (!result) {
          throw new CapabilityToolError({
            error: `Unknown connected account '${input.accountId}'.`,
          });
        }
        // The null-branch warning is surfaced on the result, never thrown — the
        // attach is recorded either way (consent is consent).
        return { sessionId, ...result };
      },
    }),
    defineCapability({
      id: 'connector.detach_account',
      title: 'Detach an account from a session',
      description:
        "Remove a connected account's tools from a session. Idempotent — detaching an account " +
        'that is not attached is a no-op. Defaults to the current session; external callers ' +
        'must pass sessionId.',
      tier: 'act',
      input: SessionAccountInputSchema,
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'connector_detach_account',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const { sessionConnectors } = requireConnectorDeps(deps);
        const sessionId = resolveSessionId(input.sessionId, context);
        sessionConnectors.detach(sessionId, input.accountId as ConnectedAccountId);
        return { detached: true, accountId: input.accountId, sessionId };
      },
    }),
  ],
};
