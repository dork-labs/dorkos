/** Real Room admission/FIRST and runtime binding; only the paid SDK transport is replaced. */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  startConnectorRuntimeMcpListener,
  createAgentRuntimeMcpServer,
} from '../../../../runtimes/connector-mcp/index.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../../../runtimes/connector-tools.js';
import { ensureInSessionAgentIdentity } from '../../../../core/agent-identity/index.js';
import * as nativePrincipals from '../../../../connectors/principal/runtime-principal-service.js';
import { resolveOriginalRoomCapabilityResponder } from '../../operations/room-responder-operation.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { composeRegistry } from '../../../../core/capabilities/registry.js';
import { registerCapabilitiesAsMcpTools } from '../../../../core/external-mcp/capability-mcp-tools.js';
import { expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { z } from 'zod';
import { IngestReceiptSchema } from '@dorkos/shared/canvas-channel-schemas';
import { nativeCommittedCodexRoomFixture } from '../../writes/__tests__/authority-fixtures.js';
import { createDocChannelDownstreamCapabilities } from '../capabilities.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { revokeOriginalDocRoute } from '../../grants.js';

const sdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      sdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-retention-source',
        runStreamed: async (prompt: unknown) => {
          sdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (sdk.parked)
                await new Promise<void>((resolve) => {
                  sdk.release = resolve;
                });
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
              };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));

function observation() {
  sdk.options.length = 0;
  sdk.prompts.length = 0;
  sdk.parked = true;
  sdk.release = undefined;
  return {
    options: sdk.options,
    prompts: sdk.prompts,
    releaseProducer: () => sdk.release?.(),
    completeFutureTurns: () => {
      sdk.parked = false;
    },
    holdFutureTurns: () => {
      sdk.parked = true;
      sdk.release = undefined;
    },
    isProducerHeld: () => sdk.release !== undefined,
  };
}

it('the shared canvas_send capability accepts only the actual Room responder and preserves exact ACK idempotency', async () => {
  let acknowledgedEventId = '';
  const h = await nativeCommittedCodexRoomFixture(
    {
      ...observation(),
      beforeResponder: async ({ fixture, principal, batchId }) => {
        const send = createDocChannelDownstreamCapabilities(fixture.http.downstream)[0]!;
        // The real producer is a member with a live binding, but has not earned responder FIRST.
        await expect(
          send.invoke(
            { logger: noopLogger },
            {
              documentId: fixture.documentId,
              roomId: fixture.roomId,
              eventId: randomUUID(),
              type: 'app.ack',
              payload: {
                batchId,
                routeId: fixture.granted.grant.routeId,
                eventIds: fixture.http.channels.getBatch(batchId)!.inputEventIds,
                outcome: 'handled',
              },
            },
            { serverPrincipal: principal }
          )
        ).rejects.toThrow();
      },
      beforeClaim: async ({ fixture, principal, batchId }) => {
        expect(fixture.http.channels.getBatch(batchId)!.status).toBe('accepted');
        const send = createDocChannelDownstreamCapabilities(fixture.http.downstream)[0]!;
        await expect(
          send.invoke(
            { logger: noopLogger },
            {
              documentId: fixture.documentId,
              roomId: fixture.roomId,
              eventId: randomUUID(),
              type: 'app.ack',
              payload: {
                batchId,
                routeId: fixture.granted.grant.routeId,
                eventIds: fixture.http.channels.getBatch(batchId)!.inputEventIds,
                outcome: 'handled',
              },
            },
            { serverPrincipal: principal }
          )
        ).rejects.toThrow();
      },
      acknowledgeCapability: async ({ fixture, principal, request }) => {
        const registry = composeRegistry(
          [
            {
              name: 'ui',
              capabilities: createDocChannelDownstreamCapabilities(fixture.http.downstream),
            },
          ],
          { logger: noopLogger }
        );
        const invoke = async (input: unknown, proof = principal): Promise<unknown> => {
          const server = new McpServer({ name: 'room-app-ack', version: '0.0.0' });
          registerCapabilitiesAsMcpTools(server, registry, 'external', { serverPrincipal: proof });
          let failed = false;
          let firstCause: unknown;
          let parsed: unknown;
          try {
            const tools = (
              server as unknown as {
                _registeredTools: Record<
                  string,
                  {
                    handler(
                      args: unknown,
                      extra: unknown
                    ): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
                  }
                >;
              }
            )._registeredTools;
            const result = await tools.canvas_send!.handler(input, {});
            const text = result.content.find((block) => block.type === 'text')?.text;
            if (result.isError || !text) throw new Error(text ?? 'MCP response missing');
            parsed = JSON.parse(text);
          } catch (cause) {
            failed = true;
            firstCause = cause;
          } finally {
            try {
              await server.close();
            } catch (cause) {
              if (!failed) {
                failed = true;
                firstCause = cause;
              }
            }
          }
          if (failed) throw firstCause;
          return parsed;
        };
        await expect(invoke({ ...request, documentId: randomUUID() })).rejects.toThrow();
        await expect(invoke({ ...request, roomId: randomUUID() })).rejects.toThrow();
        await expect(
          invoke({
            ...request,
            payload: { ...(request.payload as object), routeId: 'wrong-route' },
          })
        ).rejects.toThrow();
        await expect(
          invoke({
            ...request,
            payload: {
              ...(request.payload as object),
              eventIds: [...(request.payload as { eventIds: string[] }).eventIds, randomUUID()],
            },
          })
        ).rejects.toThrow();
        await expect(
          invoke({ ...request, payload: { ...(request.payload as object), batchId: randomUUID() } })
        ).rejects.toThrow();
        if (principal.claims.kind !== 'runtime')
          throw new Error('Actual SDK runtime proof required');
        await expect(
          invoke(request, createServerPrincipal({ ...principal.claims }))
        ).rejects.toThrow();
        await expect(
          invoke(request, createServerPrincipal({ ...principal.claims, agentId: 'another-agent' }))
        ).rejects.toThrow();
        await expect(
          invoke(
            request,
            createServerPrincipal({ ...principal.claims, bindingId: 'invented-binding' })
          )
        ).rejects.toThrow();
        await invoke({
          ...request,
          eventId: randomUUID(),
          type: 'agent.reply',
          payload: {
            inReplyTo: (request.payload as { eventIds: string[] }).eventIds,
            text: 'Responder result',
          },
        });
        const inputId = (request.payload as { eventIds: string[] }).eventIds[0]!;
        expect(
          fixture.http.channels.listDeliveries(fixture.documentId, inputId)[0]!.ackOutcome
        ).toBeNull();
        // Authenticate the actual SDK-issued bearer at the HTTP listener before projection.
        const options = sdk.options.at(-1) as { env?: Record<string, string> };
        const authorization = options.env?.DORKOS_CONNECTOR_MCP_AUTHORIZATION;
        expect(authorization).toMatch(/^Bearer /);
        const listener = await startConnectorRuntimeMcpListener({
          principals: fixture.principals,
          serverFactory: () =>
            new McpServer({ name: 'unused-connector-projection', version: '0.0.0' }),
          agentServerFactory: async (authenticated) => {
            if (authenticated.claims.kind !== 'runtime') throw new Error('Runtime proof required');
            const identity = await ensureInSessionAgentIdentity(authenticated.claims.agentPath);
            if (!identity || identity.agentPath !== fixture.originalTarget.agentPath)
              throw new Error('Genuine target identity required');
            return createAgentRuntimeMcpServer(registry, authenticated, identity);
          },
        });
        const client = new Client({ name: 'actual-room-responder', version: '0.0.0' });
        let failed = false;
        let firstCause: unknown;
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(listener.agentUrl), {
              requestInit: {
                headers: {
                  authorization: authorization!,
                  [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
                  [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent(
                    fixture.originalTarget.agentPath
                  ),
                },
              },
            })
          );
          const overHttp = async () => {
            const result = await client.callTool({
              name: 'canvas_send',
              arguments: { ...request },
            });
            expect(result.isError).not.toBe(true);
            const blocks = result.content as { type: string; text?: string }[];
            const text = blocks.find((block) => block.type === 'text')?.text;
            if (!text) throw new Error('MCP response missing');
            return JSON.parse(text) as unknown;
          };
          const first = z.object({ receipt: IngestReceiptSchema }).parse(await overHttp());
          const duplicate = await overHttp();
          expect(duplicate).toMatchObject({ receipt: { ...first.receipt, status: 'duplicate' } });
        } catch (cause) {
          failed = true;
          firstCause = cause;
        } finally {
          for (const close of [() => client.close(), () => listener.close()]) {
            try {
              await close();
            } catch (cause) {
              if (!failed) {
                failed = true;
                firstCause = cause;
              }
            }
          }
        }
        if (failed) throw firstCause;
        acknowledgedEventId = request.eventId;
        await expect(
          invoke({ ...request, payload: { ...(request.payload as object), outcome: 'rejected' } })
        ).rejects.toThrow();
        return true;
      },
    },
    'acknowledged'
  );
  try {
    const delivery = h.http.channels.listDeliveries(h.documentId, h.input.id)[0]!;
    expect(delivery.ackOutcome).toBe('handled');
    expect(delivery.ackEvidence).toMatchObject({
      admissionId: h.admission.admission_id,
      downstreamEventId: acknowledgedEventId,
    });
    expect(h.http.channels.getBatch(delivery.batchId!)!.inputEventIds).toEqual([h.input.id]);
    // Retirement/reconnect does not turn the durable accepted row into fresh runtime authority.
    await expect(
      h.http.downstream.send(
        {
          documentId: h.documentId,
          roomId: h.roomId,
          eventId: randomUUID(),
          type: 'app.ack',
          payload: {
            batchId: delivery.batchId!,
            routeId: delivery.routeId,
            eventIds: [h.input.id],
            outcome: 'handled',
          },
        },
        h.operator
      )
    ).rejects.toThrow();
  } finally {
    await h.cleanup();
  }
});

it.each(['grant', 'runtime', 'archive', 'restart'] as const)(
  'a real %s authority change refuses an active Room responder without settling input',
  async (change) => {
    let refusedCurrentResponder = false;
    await expect(
      nativeCommittedCodexRoomFixture(
        {
          ...observation(),
          acknowledgeCapability: async ({ fixture, principal, request }) => {
            if (principal.claims.kind !== 'runtime') throw new Error('Actual SDK proof required');
            if (change === 'grant')
              revokeOriginalDocRoute(
                fixture.http.grants,
                fixture.documentId,
                fixture.granted.grant.grantId,
                fixture.operator
              );
            else if (change === 'runtime')
              await fixture.principals.revoke(principal.claims.bindingId, 'turn_cancelled');
            else if (change === 'archive')
              fixture.rooms.store.updateRoom(fixture.roomId, { archived: true });
            else await fixture.principals.initializeBoot();
            const send = createDocChannelDownstreamCapabilities(fixture.http.downstream)[0]!;
            await expect(
              send.invoke({ logger: noopLogger }, request, { serverPrincipal: principal })
            ).rejects.toThrow();
            const batchId = (request.payload as { batchId: string }).batchId;
            for (const id of fixture.http.channels.getBatch(batchId)!.inputEventIds)
              expect(
                fixture.http.channels.listDeliveries(fixture.documentId, id)[0]!.ackOutcome
              ).toBeNull();
            refusedCurrentResponder = true;
            return false;
          },
        },
        'acknowledged'
      )
    ).rejects.toThrow();
    // The native terminal also refuses stale authority; no fake successful settlement is expected.
    expect(refusedCurrentResponder).toBe(true);
  }
);

it('retirement during deferred native resolution cannot restore the committed tuple or settle input', async () => {
  let checked = false;
  await expect(
    nativeCommittedCodexRoomFixture(
      {
        ...observation(),
        acknowledgeCapability: async ({ fixture, principal, request, retireResponder }) => {
          let unblock!: () => void;
          let entered!: () => void;
          const suspended = new Promise<void>((resolve) => {
            unblock = resolve;
          });
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const original = nativePrincipals.resolveOriginalNativePrincipal;
          const resolve = vi
            .spyOn(nativePrincipals, 'resolveOriginalNativePrincipal')
            .mockImplementationOnce(async (...args) => {
              const current = await original(...args);
              entered();
              await suspended;
              return current;
            });
          const pending = resolveOriginalRoomCapabilityResponder(fixture.db, principal, {
            documentId: fixture.documentId,
            batchId: (request.payload as { batchId: string }).batchId,
          });
          try {
            await started;
            await retireResponder();
            unblock();
            expect(await pending).toBeUndefined();
            const send = createDocChannelDownstreamCapabilities(fixture.http.downstream)[0]!;
            await expect(
              send.invoke({ logger: noopLogger }, request, { serverPrincipal: principal })
            ).rejects.toThrow();
            const batchId = (request.payload as { batchId: string }).batchId;
            for (const id of fixture.http.channels.getBatch(batchId)!.inputEventIds)
              expect(
                fixture.http.channels.listDeliveries(fixture.documentId, id)[0]!.ackOutcome
              ).toBeNull();
            checked = true;
            return false;
          } finally {
            unblock();
            resolve.mockRestore();
          }
        },
      },
      'acknowledged'
    )
  ).rejects.toThrow();
  expect(checked).toBe(true);
});
