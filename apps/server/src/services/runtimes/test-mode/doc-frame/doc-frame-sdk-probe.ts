/** Fixed model-free Doc workflow over the running boot's original managed-turn ports. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { openConnectorTurn } from '../../connectors/open-connector-turn.js';

export const DOC_FRAME_FIXTURE_EVENT = 'fixture.changed';
const ROUTE_ID = 'fixture-log';
const openedSchema = z.object({ success: z.literal(true), documentId: z.string().min(1) });
const configuredSchema = z.object({ configured: z.literal(true) });
const grantedSchema = z.object({ kind: z.literal('granted'), grantId: z.string().min(1) });

/** Safe readiness information, never a receipt, credential or authority proof. */
export interface DocFrameSdkReady {
  documentId: string;
  eventType: typeof DOC_FRAME_FIXTURE_EVENT;
  grantEvidence: 'verified_opener';
}
/** What a workflow can do inside the managed turn: call tools as the agent, read grants, wait. */
export interface DocFrameSdkSteps {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  grant(grantId: string): ReturnType<DocChannelStore['getGrant']>;
  /** Hold the turn until the browser test steps it. */
  waitForBrowser(): Promise<void>;
}
/** A fixed tool sequence run as the agent; the default is the log-only receipt fixture. */
export type DocFrameSdkWorkflow = (steps: DocFrameSdkSteps) => Promise<void>;
/** Process-local scenario inputs; browser JSON cannot supply tools, identity or a callback. */
export interface DocFrameSdkProbeInput {
  sessionId: string;
  agentPath: string;
  sourcePath: string;
  signal: AbortSignal;
  onReady(value: DocFrameSdkReady): void;
  waitForBrowser(): Promise<void>;
  workflow?: DocFrameSdkWorkflow;
}
export type DocFrameSdkProbe = (input: DocFrameSdkProbeInput) => Promise<void>;
/** Original boot dependencies; this module constructs no principal or authorization policy. */
export interface DocFrameSdkProbeOptions {
  enabled: boolean;
  tools: ConnectorRuntimeTools;
  channels: Pick<DocChannelStore, 'getGrant'>;
  /**
   * Bind the probe session to Claude Code. The host names the origin (the
   * test harness); this port has no origin to choose, so the session-binding
   * census counts the host, not this file.
   */
  bindProbeSession(sessionId: string, agentPath: string): Promise<void>;
}

function payload(result: unknown): unknown {
  const parsed = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    })
    .passthrough()
    .parse(result);
  if (parsed.isError) throw new Error('The fixed Doc fixture tool was refused.');
  const text = parsed.content.find((part) => part.type === 'text')?.text;
  if (!text) throw new Error('The fixed Doc fixture tool returned no result.');
  return JSON.parse(text) as unknown;
}

/** Wait for an actual browser step or exact owner cancellation, without polling or a new timer. */
async function whileCurrent<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Keep one original binding/client alive from opening through the browser's final receipt check. */
export function createDocFrameSdkProbe(options: DocFrameSdkProbeOptions): DocFrameSdkProbe {
  const active = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  return async (input) => {
    if (!options.enabled) throw new Error('The Doc SDK fixture is disabled.');
    input.signal.throwIfAborted();
    const controller = new AbortController();
    let finished!: () => void;
    const own = {
      controller,
      finished: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    const previous = active.get(input.sessionId);
    active.set(input.sessionId, own);
    previous?.controller.abort(new Error('The Doc SDK fixture turn was replaced.'));
    const cancelled = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', cancelled, { once: true });
    if (input.signal.aborted) cancelled();
    const current = () => active.get(input.sessionId) === own && !controller.signal.aborted;
    const requireCurrent = () => {
      controller.signal.throwIfAborted();
      if (!current()) throw new Error('The Doc SDK fixture turn is no longer current.');
    };
    let opened: Awaited<ReturnType<typeof openConnectorTurn>> = null;
    let client: Client | undefined;
    let browserReady = false;
    let succeeded = false;
    // Keep only a sanitized disposition; raw tool/transport failures never escape as a cause.
    let workflowFailure: 'caller_cancelled' | 'workflow_failed' | null = null;
    const cleanup = { stopFailed: false, closeFailed: false, revokeFailed: false };
    try {
      if (previous) await previous.finished;
      requireCurrent();
      await options.bindProbeSession(input.sessionId, input.agentPath);
      requireCurrent();
      opened = await openConnectorTurn(options.tools, {
        runtime: 'claude-code',
        sessionId: input.sessionId,
        agentPath: input.agentPath,
        cwd: input.agentPath,
        signal: controller.signal,
        isCurrent: current,
        onLost: () => controller.abort(new Error('The Doc SDK fixture lease ended.')),
      });
      requireCurrent();
      if (!opened) throw new Error('The Doc SDK fixture has no registered agent.');
      client = new Client({ name: 'dorkos-e2e-doc-sdk', version: '1.0.0' }, { capabilities: {} });
      await whileCurrent(
        client.connect(
          new StreamableHTTPClientTransport(new URL(opened.injection.agentToolsUrl), {
            requestInit: { headers: opened.injection.headers },
          })
        ),
        controller.signal
      );
      requireCurrent();
      const call = async (name: string, args: Record<string, unknown>) => {
        requireCurrent();
        opened!.supervisor.assertUsable();
        const value = await client!.callTool({ name, arguments: args }, undefined, {
          signal: controller.signal,
        });
        requireCurrent();
        opened!.supervisor.assertUsable();
        return payload(value);
      };
      const steps: DocFrameSdkSteps = {
        call,
        grant: (grantId) => options.channels.getGrant(grantId),
        waitForBrowser: async () => {
          browserReady = true;
          await whileCurrent(input.waitForBrowser(), controller.signal);
          requireCurrent();
        },
      };
      const receipt: DocFrameSdkWorkflow = async () => {
        const document = openedSchema.parse(
          await steps.call('control_ui', {
            action: 'open_canvas',
            content: { type: 'browser', url: input.sourcePath, title: 'SDK receipt fixture' },
          })
        );
        configuredSchema.parse(
          await steps.call('configure_doc_channel', {
            documentId: document.documentId,
            channel: {
              routes: [
                { id: ROUTE_ID, on: DOC_FRAME_FIXTURE_EVENT, to: 'log', turn: { mode: 'none' } },
              ],
            },
          })
        );
        const grantResult = await steps.call('approve_doc_route', {
          documentId: document.documentId,
          routeId: ROUTE_ID,
          allowedTypes: [DOC_FRAME_FIXTURE_EVENT],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        // A real approval request is not permission to decide it. Stop, without exposing its token.
        const grant = grantedSchema.parse(grantResult);
        const stored = steps.grant(grant.grantId);
        const evidence = z.object({ kind: z.literal('verified_opener') }).passthrough();
        if (
          !stored ||
          stored.documentId !== document.documentId ||
          stored.routeId !== ROUTE_ID ||
          !z
            .object({
              id: z.literal(ROUTE_ID),
              on: z.literal(DOC_FRAME_FIXTURE_EVENT),
              to: z.literal('log'),
              turn: z.object({ mode: z.literal('none') }).strict(),
            })
            .strict()
            .safeParse(stored.normalizedRoute).success ||
          stored.approvalId !== null ||
          !evidence.safeParse(stored.approvalEvidence).success ||
          JSON.stringify(stored.allowedTypes) !== JSON.stringify([DOC_FRAME_FIXTURE_EVENT])
        )
          throw new Error('The Doc SDK fixture lacks its genuine verified-opener log grant.');
        requireCurrent();
        input.onReady({
          documentId: document.documentId,
          eventType: DOC_FRAME_FIXTURE_EVENT,
          grantEvidence: 'verified_opener',
        });
        await steps.waitForBrowser();
      };
      await (input.workflow ?? receipt)(steps);
      requireCurrent();
      opened.supervisor.assertUsable();
      succeeded = true;
    } catch {
      // Never serialize a raw MCP/transport error, approval token, bearer or internal principal.
      workflowFailure = input.signal.aborted ? 'caller_cancelled' : 'workflow_failed';
    } finally {
      const reason = controller.signal.aborted
        ? 'turn_cancelled'
        : succeeded
          ? 'turn_terminal'
          : browserReady
            ? 'runtime_failed'
            : 'setup_failed';
      try {
        try {
          opened?.supervisor.stop();
        } catch {
          cleanup.stopFailed = true;
        }
        try {
          await client?.close();
        } catch {
          cleanup.closeFailed = true;
        }
        try {
          if (opened) await options.tools.principals.revoke(opened.binding.bindingId, reason);
        } catch {
          cleanup.revokeFailed = true;
        }
      } finally {
        input.signal.removeEventListener('abort', cancelled);
        if (active.get(input.sessionId) === own) active.delete(input.sessionId);
        finished();
      }
    }
    // Finalization has completed even when one or more cleanup siblings failed.
    if (cleanup.stopFailed || cleanup.closeFailed || cleanup.revokeFailed)
      throw new Error('The Doc SDK fixture could not confirm managed-turn cleanup.');
    if (workflowFailure === 'caller_cancelled') throw input.signal.reason;
    if (workflowFailure === 'workflow_failed')
      throw new Error('The fixed Doc SDK workflow did not complete.');
  };
}
