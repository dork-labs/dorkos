/**
 * The in-session CARD seam (DOR-1004): a capability declaring `inSessionCard`
 * draws a surface in the conversation it was called from, and — because the card
 * now owns the link and the disclosure — its agent-facing `message` stops
 * carrying them.
 *
 * The discrimination is the point of these tests. The very same capability, with
 * the very same handler, must behave differently on the two kinds of surface:
 *
 * - IN-SESSION (a live session was threaded in) — the card is pushed and the
 *   message is rewritten, because the person can see the card.
 * - SESSIONLESS (external `/mcp`, HTTP) — nothing is pushed and the message is
 *   returned byte-for-byte, because there is no card and the caller would
 *   otherwise be handed a sign-in with no link in it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import type { StreamEvent } from '@dorkos/shared/types';

import { composeRegistry, defineCapability, type CapabilityDomain } from '../index.js';
import { invokeCapabilityAsMcpResult, type InSessionSurface } from '../mcp-projection.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const AUTHORIZE_URL = 'https://mcp.test.local/authorize?code_challenge=abc';
const DISCLOSURE = 'DorkOS stores the token for granola on this machine.';
const FULL_MESSAGE = `[Sign in to ${SERVER}](${AUTHORIZE_URL})\n\n${DISCLOSURE}\n\nTell me when you’ve signed in.`;

/**
 * A stand-in for `mcp.signin` / `mcp.poll_signin`: the same declarations and the
 * same result shapes, without the OAuth engine behind them. The seam under test
 * reads only the declaration and the payload, so this pins its behaviour without
 * pinning the mesh domain's wiring (which `mcp-capabilities-signin.test.ts`
 * covers).
 */
function domain(
  pollStatus: 'pending' | 'connected' | 'failed',
  alreadyConnected = false,
  authorizeUrl: string = AUTHORIZE_URL
) {
  const signin: CapabilityDomain = {
    name: 'fake',
    capabilities: [
      defineCapability({
        id: 'fake.signin',
        title: 'Sign in',
        description: 'Begin signing in.',
        tier: 'act',
        input: z.object({ agentId: z.string(), name: z.string() }),
        output: z.object({
          flowId: z.string(),
          authorizeUrl: z.string().optional(),
          alreadyConnected: z.boolean(),
          disclosure: z.string(),
          message: z.string(),
        }),
        surfaces: { mcp: { toolName: 'fake_signin', servers: ['in-session', 'external'] } },
        inSessionCard: 'signin',
        invoke: async () => ({
          flowId: 'flow-1',
          ...(alreadyConnected ? {} : { authorizeUrl }),
          alreadyConnected,
          disclosure: DISCLOSURE,
          message: alreadyConnected ? `You’re already signed in to ${SERVER}.` : FULL_MESSAGE,
        }),
      }),
      defineCapability({
        id: 'fake.poll',
        title: 'Poll sign-in',
        description: 'Check a sign-in.',
        tier: 'act',
        input: z.object({ flowId: z.string() }),
        output: z.object({ status: z.enum(['pending', 'connected', 'failed']) }),
        surfaces: { mcp: { toolName: 'fake_poll', servers: ['in-session', 'external'] } },
        inSessionCard: 'signin_resolved',
        invoke: async () => ({ status: pollStatus }),
      }),
      defineCapability({
        id: 'fake.plain',
        title: 'Plain',
        description: 'Declares no card.',
        tier: 'act',
        input: z.object({ agentId: z.string(), name: z.string() }),
        output: z.object({ message: z.string() }),
        surfaces: { mcp: { toolName: 'fake_plain', servers: ['in-session', 'external'] } },
        invoke: async () => ({ message: FULL_MESSAGE }),
      }),
    ],
  };
  return signin;
}

/** The plain payload inside an MCP text result. */
function payloadOf(result: {
  content: { type: string; text?: string }[];
}): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? 'null') as Record<string, unknown>;
}

describe('in-session card seam', () => {
  let queue: StreamEvent[];
  let notified: number;
  let surface: InSessionSurface;

  beforeEach(() => {
    queue = [];
    notified = 0;
    surface = {
      session: {
        eventQueue: queue,
        eventQueueNotify: () => {
          notified += 1;
        },
      },
    };
  });

  describe('mcp.signin — the two surfaces', () => {
    it('pushes the card and drops the link from the message, in session', async () => {
      const registry = composeRegistry([domain('pending')], { logger: noopLogger });

      const result = await invokeCapabilityAsMcpResult(
        registry,
        'fake.signin',
        { agentId: AGENT_ID, name: SERVER },
        undefined,
        surface
      );

      expect(queue).toEqual([
        {
          type: 'mcp_signin_required',
          data: {
            serverName: SERVER,
            agentId: AGENT_ID,
            flowId: 'flow-1',
            authorizeUrl: AUTHORIZE_URL,
            disclosure: DISCLOSURE,
          },
        },
      ]);
      expect(notified).toBe(1);
      const payload = payloadOf(result);
      // The card owns both now — the agent must not paste either a second time.
      expect(payload.message).not.toContain(AUTHORIZE_URL);
      expect(payload.message).not.toContain(DISCLOSURE);
      expect(String(payload.message)).toContain('already on screen');
      // Everything else is untouched: the flow is still the caller's to name.
      expect(payload.flowId).toBe('flow-1');
      expect(payload.authorizeUrl).toBe(AUTHORIZE_URL);
      expect(payload.disclosure).toBe(DISCLOSURE);
    });

    it('keeps the full link-carrying message on a sessionless surface', async () => {
      const registry = composeRegistry([domain('pending')], { logger: noopLogger });

      const result = await invokeCapabilityAsMcpResult(registry, 'fake.signin', {
        agentId: AGENT_ID,
        name: SERVER,
      });

      expect(queue).toEqual([]);
      const payload = payloadOf(result);
      expect(payload.message).toBe(FULL_MESSAGE);
      expect(String(payload.message)).toContain(AUTHORIZE_URL);
      expect(String(payload.message)).toContain(DISCLOSURE);
    });

    it('draws no card when the server was already connected', async () => {
      const registry = composeRegistry([domain('pending', true)], { logger: noopLogger });

      const result = await invokeCapabilityAsMcpResult(
        registry,
        'fake.signin',
        { agentId: AGENT_ID, name: SERVER },
        undefined,
        surface
      );

      expect(queue).toEqual([]);
      expect(payloadOf(result).message).toContain('already signed in');
    });

    it.each([
      ['javascript:alert(1)'],
      ['data:text/html,<script>alert(1)</script>'],
      ['http://evil.example/authorize'],
      ['not-a-url'],
    ])('refuses to draw a card for an unsafe link (%s), falling back to prose', async (bad) => {
      // A card is a button a person is told it is safe to press. A link the wire
      // schema would reject must not become one — and the refusal has to be
      // GRACEFUL: validating only at the boundary would drop the frame silently
      // and leave the person with no sign-in at all. Skipping the card returns the
      // capability's own markdown instead, so the link still reaches them.
      const registry = composeRegistry([domain('pending', false, bad)], { logger: noopLogger });

      const result = await invokeCapabilityAsMcpResult(
        registry,
        'fake.signin',
        { agentId: AGENT_ID, name: SERVER },
        undefined,
        surface
      );

      expect(queue).toEqual([]);
      // Untouched: the full message, link and disclosure included.
      expect(payloadOf(result).message).toBe(FULL_MESSAGE);
    });

    it('still draws a card for an http link on loopback', async () => {
      // A provider running on this machine is reached over plain http, and the
      // mock provider the OAuth tests drive is exactly that. Refusing it would
      // break local MCP servers for no security gain.
      const local = 'http://127.0.0.1:9000/authorize';
      const registry = composeRegistry([domain('pending', false, local)], { logger: noopLogger });

      await invokeCapabilityAsMcpResult(
        registry,
        'fake.signin',
        { agentId: AGENT_ID, name: SERVER },
        undefined,
        surface
      );

      expect(queue).toHaveLength(1);
      expect(queue[0].data).toMatchObject({ authorizeUrl: local });
    });

    it('draws no card for a capability that declares none', async () => {
      const registry = composeRegistry([domain('pending')], { logger: noopLogger });

      const result = await invokeCapabilityAsMcpResult(
        registry,
        'fake.plain',
        { agentId: AGENT_ID, name: SERVER },
        undefined,
        surface
      );

      expect(queue).toEqual([]);
      expect(payloadOf(result).message).toBe(FULL_MESSAGE);
    });
  });

  describe('mcp.poll_signin — retiring the card', () => {
    it.each(['connected', 'failed'] as const)('resolves the card on %s', async (status) => {
      const registry = composeRegistry([domain(status)], { logger: noopLogger });

      await invokeCapabilityAsMcpResult(
        registry,
        'fake.poll',
        { flowId: 'flow-1' },
        undefined,
        surface
      );

      expect(queue).toEqual([
        { type: 'mcp_signin_resolved', data: { flowId: 'flow-1', outcome: status } },
      ]);
    });

    it('leaves the card alone while the sign-in is still pending', async () => {
      const registry = composeRegistry([domain('pending')], { logger: noopLogger });

      await invokeCapabilityAsMcpResult(
        registry,
        'fake.poll',
        { flowId: 'flow-1' },
        undefined,
        surface
      );

      expect(queue).toEqual([]);
    });

    it('resolves nothing on a sessionless surface', async () => {
      const registry = composeRegistry([domain('connected')], { logger: noopLogger });

      await invokeCapabilityAsMcpResult(registry, 'fake.poll', { flowId: 'flow-1' });

      expect(queue).toEqual([]);
    });
  });
});
