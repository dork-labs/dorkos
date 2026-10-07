/** Paid SDK events alone are mocked; original runtime constructor, native bearer, FILE writer and MCP projection remain real. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import { SESSION_AGENT_AUTHOR } from '../../scopes.js';
import { CanvasChannelCheckboxReceiptSchema } from '@dorkos/shared/canvas-channel-schemas';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { createDocChannelCheckboxCapabilities } from '../writes/checkbox-capabilities.js';
import { composeRegistry } from '../../../core/capabilities/registry.js';
import {
  invokeCapabilityAsMcpResult,
  capabilitiesForMcpServer,
} from '../../../core/capabilities/mcp-projection.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { currentRoomDueServicePort } from '../service.js';
import { startNativeCodexCapabilityProducer } from '../writes/__tests__/native-capability-producer.js';

const sdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      sdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-checkbox-mcp-source',
        runStreamed: async (prompt: unknown) => {
          sdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-checkbox-mcp-source' };
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

it('refuses runtime Room FILE edits and projects the original active principal into its own session FILE mutation, exact retry and revoked-write refusal', async () => {
  sdk.options.length = 0;
  sdk.prompts.length = 0;
  sdk.release = undefined;
  const agentDir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'native-checkbox-mcp-agent-'))
  );
  const sessionId = 'native-checkbox-mcp-source',
    agentId = '01JNATIVECHECKBOXMCP0000000';
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let producer: Awaited<ReturnType<typeof startNativeCodexCapabilityProducer>> | undefined;
  let failed = false,
    first: unknown;
  const attempt = async (work: () => Promise<unknown> | unknown) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  try {
    await fs.mkdir(join(agentDir, '.dork'), { recursive: true });
    await fs.writeFile(
      join(agentDir, '.dork', 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'native-checkbox-mcp',
        runtime: 'codex',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: new Date().toISOString(),
        registeredBy: 'test',
      })
    );
    h = await nativeRoomAuthorityFixture(agentDir, 'codex', sessionId, agentId, {
      checkboxFile: true,
      coalesceWindowMs: 100,
    });
    producer = await startNativeCodexCapabilityProducer(h, {
      options: sdk.options,
      prompts: sdk.prompts,
      releaseProducer: () => sdk.release?.(),
      completeFutureTurns: () => {},
    });
    const runtimes = new RuntimeRegistry();
    runtimes.setDb(h.db);
    runtimes.register(producer.runtime);
    const registry = composeRegistry(
      [{ name: 'ui', capabilities: createDocChannelCheckboxCapabilities() }],
      { logger: noopLogger, docChannelCheckboxWriter: h.http.checkboxWriter }
    );
    expect(
      capabilitiesForMcpServer(registry, 'in-session').map(
        (capability) => capability.surfaces.mcp!.toolName
      )
    ).toContain('canvas_set_checkbox');
    const context = producer.context;
    const before = await fs.readFile(h.checkboxPath!);
    // A write grant never expands existing Room editing rights: those files are people-only.
    await expect(
      invokeCapabilityAsMcpResult(
        registry,
        'ui.set_canvas_checkbox',
        await h.checkboxRequest(true),
        context
      )
    ).rejects.toThrow('PEOPLE_ONLY');
    expect(await fs.readFile(h.checkboxPath!)).toEqual(before);
    expect(
      h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()
    ).toEqual({ n: 0 });
    // The same genuine native runtime may edit its own session canvas under the
    // existing editor policy, still requiring a separately consumed original write grant.
    const documentId = h.rooms.canvas.open(
      'session:' + sessionId,
      SESSION_AGENT_AUTHOR,
      { type: 'markdown', content: before.toString('utf8'), sourcePath: h.checkboxPath! },
      {
        tree: {
          resolvedCwd: agentDir,
          treeKind: 'agent-cwd',
          sourceLabel: null,
          aheadOfMain: null,
        },
      }
    ).id;
    h.http.grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'native-session',
            on: 'md.*',
            to: 'agent:owner',
            turn: { mode: 'coalesce', windowMs: 100, maxBatch: 10 },
          },
        ],
      },
      h.operator,
      agentId
    );
    const grantRequest = {
      documentId,
      routeId: 'native-session',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const pending = await h.http.grantCheckboxRoute(grantRequest, h.operator);
    expect(pending.kind).toBe('approval_required');
    if (pending.kind !== 'approval_required')
      throw new Error('Original session FILE approval missing');
    h.approvals.grant(pending.ticket.approvalId);
    const granted = await h.http.grantCheckboxRoute(grantRequest, h.operator, pending.ticket.token);
    expect(granted.kind).toBe('granted');
    if (granted.kind !== 'granted') throw new Error('Original session FILE grant missing');
    const request = { ...(await h.checkboxRequest(true, randomUUID())), documentId };
    await expect(
      invokeCapabilityAsMcpResult(registry, 'ui.set_canvas_checkbox', request)
    ).rejects.toThrow('CANVAS_DOCUMENT_NOT_FOUND');
    expect(await fs.readFile(h.checkboxPath!)).toEqual(before);
    const response = await invokeCapabilityAsMcpResult(
      registry,
      'ui.set_canvas_checkbox',
      request,
      context
    );
    expect(response.isError).not.toBe(true);
    const data = response.content.find((item) => item.type === 'text');
    if (!data || data.type !== 'text') throw new Error('MCP receipt missing');
    const receipt = CanvasChannelCheckboxReceiptSchema.parse(JSON.parse(data.text));
    expect(receipt).toMatchObject({ status: 'changed', receipt: { id: request.eventId } });
    const due = currentRoomDueServicePort(h.http.service);
    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    due.wake();
    await due.pump(runtimes);
    expect(h.db.$client.prepare('SELECT count(*) AS n FROM room_doc_admissions').get()).toEqual({
      n: 0,
    });
    const after = await fs.readFile(h.checkboxPath!),
      inode = (await fs.stat(h.checkboxPath!)).ino;
    const retry = await invokeCapabilityAsMcpResult(
      registry,
      'ui.set_canvas_checkbox',
      request,
      context
    );
    expect(retry).toEqual(response);
    expect((await fs.stat(h.checkboxPath!)).ino).toBe(inode);
    expect(await fs.readFile(h.checkboxPath!)).toEqual(after);
    expect(sdk.prompts).toHaveLength(1); // Busy original turn is distinct from native FILE acknowledgement.
    expect(
      h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()
    ).toEqual({ n: 1 });
    expect(h.http.channels.listDeliveries(documentId, request.eventId)).toHaveLength(1);
    expect(h.http.channels.listDeliveries(documentId, request.eventId)[0]!.ackOutcome).toBeNull();
    h.http.grants.revoke(documentId, granted.grant.grantId, h.operator);
    await expect(
      invokeCapabilityAsMcpResult(
        registry,
        'ui.set_canvas_checkbox',
        { ...(await h.checkboxRequest(false, randomUUID())), documentId },
        context
      )
    ).rejects.toThrow();
    expect(await fs.readFile(h.checkboxPath!)).toEqual(after);
    expect(
      h.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_write_intents').get()
    ).toEqual({ n: 1 });
    expect(sdk.prompts).toHaveLength(1);
  } catch (cause) {
    failed = true;
    first = cause;
  }
  if (producer) await attempt(() => producer!.close());
  let drained = false;
  if (h)
    await attempt(async () => {
      await h!.cleanup();
      drained = true;
    });
  if (drained || !h) await attempt(() => fs.rm(agentDir, { recursive: true, force: true }));
  if (failed) throw first;
});
