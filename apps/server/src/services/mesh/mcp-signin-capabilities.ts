/**
 * The sign-in half of the `mcp.*` capability domain: starting an OAuth sign-in
 * for a managed server, checking whether it finished, and — for a provider that
 * will not let DorkOS register itself — storing the app credentials an operator
 * got from that provider (DOR-982).
 *
 * Split from the management verbs in `mcp-capabilities.ts` because the two
 * groups answer different questions (what servers does this agent have? / can
 * DorkOS get into this one?) over the same dependency bag, which lives in
 * `mcp-capability-deps.ts`.
 *
 * @module services/mesh/mcp-signin-capabilities
 */
import { z } from 'zod';

import { defineCapability, type CapabilityDefinition } from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { mcpOAuthCustodyDisclosure } from './agent-mcp-oauth-service.js';
import { McpSigninStartError } from './mcp-signin-failure.js';
import {
  AgentServerInput,
  agentIdField,
  requireMcpDeps,
  requireOAuth,
  resolveOAuthServerUrl,
  serverNameField,
} from './mcp-capability-deps.js';

/**
 * Re-raise a failed sign-in start as the caller-facing error shape: the plain
 * family as `error`, the machine-readable family as `code`, and the raw OAuth
 * text demoted to `detail` so a surface can put it behind a disclosure instead
 * of leading with it (DOR-982).
 *
 * @param err - Whatever `startSignin` threw.
 */
function rethrowSigninFailure(err: unknown): never {
  if (err instanceof McpSigninStartError) {
    const { message, code, detail } = err.failure;
    throw new CapabilityToolError({ error: message, code, detail });
  }
  throw new CapabilityToolError({
    error: err instanceof Error ? err.message : 'Could not start the sign-in.',
  });
}

/** The three sign-in verbs, spread into the `mcp` domain's capability list. */
export const mcpSigninCapabilities: CapabilityDefinition[] = [
  defineCapability({
    id: 'mcp.signin',
    title: 'Start OAuth sign-in for a managed MCP server',
    description:
      'Begin signing in to an OAuth-protected managed server. In a DorkOS conversation the ' +
      'sign-in card is shown to the user automatically — say ONE short line naming what you ' +
      'are connecting, then stop. Do not repeat the link or the disclosure, do not ask the ' +
      'user to tell you when they are done, and do not poll for the result: you are brought ' +
      'back automatically once the sign-in lands, with the server named and its tools ready. ' +
      'On surfaces with no card the result’s message field carries the link and the custody ' +
      'disclosure instead — show BOTH verbatim there. DorkOS obtains and refreshes the token ' +
      'for you either way. If this fails with code SIGNIN_NO_APP_REGISTRATION, the provider ' +
      'will not register DorkOS automatically: tell the person they can add their own app ' +
      'credentials on the server’s card in agent settings, and do not try again unprompted.',
    // `act`, not `destructive`: the operator already approved this server at
    // `mcp.add` (a command-diff gate). Sign-in introduces no new command — it
    // only stores a token for a server that is already trusted — so it needs no
    // second approval, exactly like connector.start_connect.
    tier: 'act',
    input: AgentServerInput,
    output: z.object({
      flowId: z
        .string()
        .describe('The sign-in flow id, for the poll-sign-in tool if a surface needs it.'),
      authorizeUrl: z
        .string()
        .optional()
        .describe('The sign-in link to open; absent when the server was already connected.'),
      alreadyConnected: z
        .boolean()
        .describe('True when a live token already existed, so no browser step is needed.'),
      disclosure: z.string().describe('The custody disclosure to show verbatim before the link.'),
      message: z.string().describe('Ready-to-render markdown carrying the link and disclosure.'),
    }),
    surfaces: {
      mcp: {
        toolName: 'mcp_signin',
        servers: ['in-session', 'external'],
        annotations: { openWorldHint: true },
      },
    },
    // In a conversation the link and the disclosure belong on a card, not in
    // the agent's prose (DOR-1004). The in-session projection draws it and
    // rewrites `message` accordingly; every sessionless surface never reaches
    // that code and keeps the full link-carrying markdown below.
    inSessionCard: 'signin',
    invoke: async (deps, input, context) => {
      const { service } = requireMcpDeps(deps);
      const oauth = requireOAuth(deps);
      const serverUrl = await resolveOAuthServerUrl(service, input.agentId, input.name);
      const disclosure = mcpOAuthCustodyDisclosure(input.name);
      let started;
      try {
        started = await oauth.startSignin(
          {
            agentId: input.agentId,
            serverName: input.name,
            serverUrl,
          },
          // The invoking session, and the whole reason the agent can be brought
          // back on its own once the token lands (DOR-1004). Set ONLY on the
          // in-session surface — the external `/mcp` server and HTTP leave it
          // absent by construction (`CapabilityInvocationContext.sessionId`), so
          // a sessionless sign-in records no session and resumes nothing. Its
          // directory rides along so the resume still lands in the right place
          // after a restart (DOR-981).
          context.sessionId
            ? {
                originSessionId: context.sessionId,
                ...(context.cwd ? { originCwd: context.cwd } : {}),
              }
            : {}
        );
      } catch (err) {
        rethrowSigninFailure(err);
      }
      // Getting this far means the provider's OAuth discovery answered, so the
      // server really is OAuth-protected — record it, so the row keeps offering
      // a sign-in after a restart even before any turn runs (DOR-985). The
      // sign-in itself is what the caller asked for, so a failed write is
      // reported and shrugged off rather than failing the call.
      await service.learnOAuthAuthKind(input.agentId, input.name).catch((err: unknown) => {
        deps.logger.warn(
          `[mcp.signin] could not record authKind for "${input.name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return false;
      });
      const message = started.alreadyConnected
        ? `You’re already signed in to ${input.name}. ${disclosure}`
        : `[Sign in to ${input.name}](${started.authorizeUrl})\n\n${disclosure}\n\n` +
          `Tell me when you’ve signed in, then I’ll check.`;
      return {
        flowId: started.flowId,
        ...(started.authorizeUrl ? { authorizeUrl: started.authorizeUrl } : {}),
        alreadyConnected: started.alreadyConnected,
        disclosure,
        message,
      };
    },
  }),
  defineCapability({
    id: 'mcp.poll_signin',
    title: 'Check an MCP sign-in flow',
    description:
      'Check whether an MCP sign-in the user was sent to complete has finished. Returns ' +
      'pending, connected, or failed. Call after the user says they have signed in; once ' +
      'connected, the server’s tools are injected on the next turn. When it returns a ' +
      'toolCount, tell the user what they just unlocked — "Connected — 12 tools." — and ' +
      'say plain "Connected." when no count came back (absent means uncounted, not zero).',
    tier: 'act',
    input: z.object({
      flowId: z.string().min(1).describe('The flow id from mcp_signin.'),
    }),
    output: z.object({
      status: z
        .enum(['pending', 'connected', 'failed'])
        .describe('Whether the sign-in is still waiting, done, or failed.'),
      error: z.string().optional().describe('The failure reason, when the status is failed.'),
      toolCount: z
        .number()
        .optional()
        .describe('How many tools the server exposes, counted once the sign-in connected.'),
    }),
    surfaces: {
      mcp: {
        toolName: 'mcp_poll_signin',
        servers: ['in-session', 'external'],
        annotations: { idempotentHint: true, openWorldHint: true },
      },
    },
    // A terminal answer here retires the conversation's sign-in card, for the
    // path where the agent — not the person's own browser tab — is what
    // learns the sign-in landed (DOR-1004).
    inSessionCard: 'signin_resolved',
    invoke: async (deps, input) => {
      const oauth = requireOAuth(deps);
      return oauth.pollSignin(input.flowId);
    },
  }),
  defineCapability({
    id: 'mcp.set_client',
    title: 'Use your own app credentials for a managed MCP server',
    description:
      'Store the app credentials a person got from a provider that will not let DorkOS ' +
      'register itself, so the next sign-in uses their app. Saving replaces the server’s ' +
      'stored sign-in, so the person signs in again afterwards.',
    // `act`, on the same reasoning as `mcp.signin`: the server was approved at
    // `mcp.add`, and this introduces no new command — it stores a credential for
    // an endpoint that is already trusted. It is NOT `destructive` even though it
    // discards the stored sign-in, because that discard is what makes the new
    // credential honest and is recovered by signing in again.
    tier: 'act',
    input: z.object({
      agentId: agentIdField,
      name: serverNameField,
      clientId: z
        .string()
        .min(1)
        .describe('The client id (sometimes "app id") the provider issued.'),
      clientSecret: z
        .string()
        .min(1)
        .optional()
        .describe('The client secret, when the provider issued one.'),
    }),
    output: z.object({
      saved: z.literal(true).describe('The credentials were stored; sign in again to use them.'),
    }),
    // NO `mcp` surface, deliberately: this verb carries a secret in its INPUT,
    // and an MCP tool call is recorded in the session transcript. Every other
    // credential DorkOS holds is written by a person at a form and read by
    // nobody, and this one is no different. The cockpit reaches it through the
    // generic `POST /api/capabilities/:id/invoke` path, like the other MCP verbs.
    surfaces: {
      http: { method: 'put', path: '/api/agents/{agentId}/mcp-servers/{name}/client' },
    },
    invoke: async (deps, input) => {
      const { service } = requireMcpDeps(deps);
      const oauth = requireOAuth(deps);
      const serverUrl = await resolveOAuthServerUrl(service, input.agentId, input.name);
      await oauth.saveManualClientInfo(
        { agentId: input.agentId, serverName: input.name, serverUrl },
        {
          clientId: input.clientId,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
        }
      );
      // A server whose provider needs its own app registration is an OAuth
      // server by definition, so record that too — the row then keeps offering a
      // sign-in even if discovery never got far enough to prove it (DOR-985).
      await service.learnOAuthAuthKind(input.agentId, input.name).catch((err: unknown) => {
        deps.logger.warn(
          `[mcp.set_client] could not record authKind for "${input.name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return false;
      });
      return { saved: true as const };
    },
  }),
];
