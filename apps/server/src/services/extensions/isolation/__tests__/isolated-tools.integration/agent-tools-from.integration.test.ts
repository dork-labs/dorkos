import {
  ID,
  NAME,
  DOMAIN,
  boot,
  call,
  childStats,
  childPid,
  refusalOf,
  until,
  alive,
  toolErrorOf,
  st,
} from './harness.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { createDataProviderContext } from '../../../extension-server-api-factory.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from '../isolation-harness.js';
import { CtxDispatcher } from '../../ctx-dispatcher.js';

describe('agent tools from an isolated extension (real child)', () => {
  // Purpose: an agent's call returns the child's own result: it ran in the
  // extension's process (not DorkOS's), and only the declared tools it
  // handled are in the registry.
  it('answers an agent call from its own process', async () => {
    await boot();
    expect(st.registry.get(`${DOMAIN}.echo`)?.source).toEqual({
      kind: 'extension',
      id: ID,
      name: NAME,
    });
    const result = (await call('echo', { message: 'hi' })) as Record<string, unknown>;
    expect(result.message).toBe('hi');
    expect(result.pid).toBe(await childPid());
    expect(result.pid).not.toBe(process.pid);
    expect(alive(result.pid as number)).toBe(true);
    // No registered agent lives at the caller's folder: unknown, as in-process.
    expect(result.agentId).toBeNull();
    expect(st.registry.capabilities.filter((c) => c.id.startsWith(`${DOMAIN}.`))).toHaveLength(7);
  }, 60_000);

  // Purpose: extension code has no public raw channel (process.send is
  // locked away before the bundle loads), and a binding it tries to forge
  // after register() returned never becomes a tool.
  it('gives extension code no raw channel, and never offers a tool bound late', async () => {
    await boot();
    expect((await childStats()).sendType).toBe('undefined');
    // The late binding's refusal is the signal that it arrived; only then is
    // the missing tool an answer rather than a race.
    await vi.waitFor(() => {
      const card = st.manager.listPublic().find((r) => r.id === ID);
      expect(card?.tools?.find((t) => t.name === 'late')).toMatchObject({ status: 'refused' });
    });
    expect(st.registry.get(`${DOMAIN}.late`)).toBeUndefined();
  }, 60_000);

  // Purpose: the gate runs in DorkOS, unchanged, BEFORE anything reaches the
  // child: a Blocked Extension tools area refuses the call, and a
  // destructive tool waits for a person even under Full; the child counts
  // no call for either. A person's yes then runs it once.
  it('gates every call in DorkOS before the child hears of it', async () => {
    await boot();
    const before = (await childStats()).calls;

    st.agentPermissions = { areas: { extensions: 'blocked' } };
    const blocked = await refusalOf(call('echo', { message: 'x' }));
    expect(blocked).toMatchObject({ status: 'denied', reason: 'permission_blocked' });
    st.agentPermissions = undefined;

    st.preset = 'full';
    const asked = await refusalOf(call('delete_note', { message: 'n-1' }));
    expect(asked).toMatchObject({ status: 'approval_required' });
    expect((await childStats()).calls).toBe(before);

    const { approvalId, approvalToken } = asked as { approvalId: string; approvalToken: string };
    expect(st.approvals.grant(approvalId)).toBeUndefined();
    expect(await call('delete_note', { message: 'n-1' }, approvalToken)).toEqual({ deleted: true });
    expect(await childStats()).toMatchObject({ calls: before + 1, deleted: 1 });
  }, 60_000);

  // Purpose: the host wrapper's deadline (timeoutSeconds: 1) aborts the
  // call, and the abort reaches the handler's call.signal in the child.
  it('aborts the child’s call.signal at the deadline', async () => {
    await boot();
    const started = Date.now();
    const error = await toolErrorOf(call('wait_for_abort'));
    expect(error).toEqual({
      error: `${NAME} didn't answer in 1 seconds.`,
      code: 'EXTENSION_TOOL_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(async () => (await childStats()).aborts === 1);
  }, 60_000);

  // Purpose: a result over 256 KB passes the channel (under 4 MB) but is
  // refused by the host wrapper, as in-process.
  it('refuses a result over 256 KB', async () => {
    await boot();
    expect(await toolErrorOf(call('big'))).toEqual({
      error: `${NAME} returned more than the agent can read.`,
      code: 'EXTENSION_TOOL_BAD_RESULT',
    });
  }, 60_000);

  // Purpose: the child dying mid-call fails the call as stopped, and by the
  // time it fails the tool is already gone from the registry (removed
  // first). A restart offers the tools again, from a new process.
  it('fails a call as stopped when the child dies, then offers the tools again', async () => {
    await boot();
    const first = await childPid();
    // What the registry held when the host released the dead child and
    // rejected its waiting calls: the lifecycle's onGone must have removed
    // the tool by then, whatever the microtask order.
    const atClose: boolean[] = [];
    const close = CtxDispatcher.prototype.close;
    const spy = vi.spyOn(CtxDispatcher.prototype, 'close').mockImplementation(function (
      this: CtxDispatcher
    ) {
      atClose.push(st.registry.get(`${DOMAIN}.crash_mid_call`) !== undefined);
      return close.call(this);
    });
    let goneWhenRejected: boolean | null = null;
    const pending = call('crash_mid_call').catch((err: unknown) => {
      goneWhenRejected = st.registry.get(`${DOMAIN}.echo`) === undefined;
      throw err;
    });
    expect(await toolErrorOf(pending)).toEqual({
      error: `${NAME} stopped while this ran.`,
      code: 'EXTENSION_TOOL_STOPPED',
    });
    expect(goneWhenRejected).toBe(true);
    await vi.waitFor(() => expect(atClose).toHaveLength(1), { timeout: 5_000 });
    expect(atClose).toEqual([false]);
    spy.mockRestore();
    expect(st.registry.get(`${DOMAIN}.crash_mid_call`)).toBeUndefined();
    await until(() => !alive(first));

    await until(() => st.registry.get(`${DOMAIN}.echo`) !== undefined);
    const again = (await call('echo', { message: 'back' })) as Record<string, unknown>;
    expect(again.message).toBe('back');
    expect(again.pid).not.toBe(first);
    expect(again.pid).toBe(await childPid());
  }, 60_000);

  // Purpose: a handler stuck in a synchronous loop freezes the whole child;
  // the watchdog kills it, the tool leaves the registry, and the call fails
  // as stopped rather than waiting out its 60-second deadline.
  it('removes the tools of a child the watchdog killed for hanging in a handler', async () => {
    await boot();
    const pid = await childPid();
    const started = Date.now();
    expect(await toolErrorOf(call('hang'))).toEqual({
      error: `${NAME} stopped while this ran.`,
      code: 'EXTENSION_TOOL_STOPPED',
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(st.registry.get(`${DOMAIN}.hang`)).toBeUndefined();
    await until(() => !alive(pid));
  }, 60_000);
});

describe('the isolated host on a child exit (real child)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: the host closes tool binding the moment `registered` arrives.
  // Code in the child posting its own binding right after register()
  // returned (here on the raw channel the test seam keeps) is refused with
  // the in-process words, and the host's real binding never holds it.
  it('refuses a tool binding that arrives after registered', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'late.js');
    await fs.writeFile(
      bundle,
      String.raw`
'use strict';
module.exports = function register(_router, ctx) {
  ctx.tools.handle('wait', () => 1);
  setImmediate(() => process.send({ type: 'expose', id: 9001, path: 'tools.handle', name: 'late' }));
};
module.exports.probes = {};
`
    );
    const manifest = ExtensionManifestSchema.parse({
      id: 'late-bind',
      name: 'Late Bind',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
      tools: ['wait', 'late'].map((name) => ({
        name,
        title: name,
        description: 'A test tool.',
        tier: 'observe',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })),
    });
    const toolChecks = checkDeclaredTools(manifest);
    const built = createDataProviderContext({
      extensionId: 'late-bind',
      extensionDir: path.join(h.tmp, 'ext', 'late-bind'),
      dorkHome: h.dorkHome,
      extensionName: 'Late Bind',
      toolChecks,
    });
    const host = makeHost(h, {
      id: 'late-bind',
      bundle,
      overrides: { ctx: built.ctx, tools: toolChecks },
    });
    await startOk(host);
    await vi.waitFor(() =>
      expect(
        h.logs.some((l) => l.message.includes('refused a tool binding after register()'))
      ).toBe(true)
    );
    expect(built.tools.seal().handled.map((x) => x.tool.name)).toEqual(['wait']);
    built.dispose();
  }, 30_000);

  // Purpose: when a running child dies, onGone (where the lifecycle takes its
  // tools out of the registry) runs FIRST: while the child's tool binding is
  // still held on the real ctx and before the call waiting on it is
  // rejected; only then is everything released and onExit told. This pins
  // DOR-2685's stop order structurally, not by microtask timing.
  it('calls onGone before it releases the child or rejects its calls', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'tool.js');
    await fs.writeFile(bundle, BUNDLE);
    const manifest = ExtensionManifestSchema.parse({
      id: 'gone-order',
      name: 'Gone Order',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
      tools: [
        {
          name: 'wait',
          title: 'Wait',
          description: 'Never answers.',
          tier: 'observe',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    const toolChecks = checkDeclaredTools(manifest);
    const built = createDataProviderContext({
      extensionId: 'gone-order',
      extensionDir: path.join(h.tmp, 'ext', 'gone-order'),
      dorkHome: h.dorkHome,
      extensionName: 'Gone Order',
      toolChecks,
    });
    const order: string[] = [];
    let settled = false;
    let registrationsAtGone = -1;
    // The callbacks read `host` only once the child runs, after this line.
    const host = makeHost(h, {
      id: 'gone-order',
      bundle,
      onExit: () => order.push(`exit:${host.ctxRegistrations}`),
      overrides: {
        ctx: built.ctx,
        tools: toolChecks,
        onGone: () => {
          registrationsAtGone = host.ctxRegistrations;
          order.push(`gone:${settled ? 'settled' : 'waiting'}`);
        },
      },
    });
    await startOk(host);
    const { handled } = built.tools.seal();
    expect(handled.map((x) => x.tool.name)).toEqual(['wait']);
    const pending = Promise.resolve(
      handled[0]!.handler(
        {},
        Object.freeze({ signal: new AbortController().signal, agentId: null })
      )
    ).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);
    await host.probe('crash');
    await expect(pending).rejects.toThrow('Probe stopped.');
    expect(registrationsAtGone).toBe(1);
    expect(order).toEqual(['gone:waiting', 'exit:0']);
    built.dispose();
  }, 30_000);

  /** A bundle that binds one tool that never answers, and can crash on cue. */
  const BUNDLE = String.raw`
'use strict';
module.exports = function register(_router, ctx) {
  ctx.tools.handle('wait', () => new Promise(() => undefined));
};
module.exports.probes = {
  crash: () => { setTimeout(() => process.abort(), 10); return 'crashing'; },
};
`;
});
