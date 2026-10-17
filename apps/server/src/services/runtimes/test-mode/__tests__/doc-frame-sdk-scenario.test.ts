/** Scenario scheduling and confined file ownership only, not SDK/server acceptance. */
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { interactionGate } from '../interaction-gate.js';
import {
  configureDocFrameSdkProbe,
  docFrameSdkScenario,
  DOC_FRAME_SDK_FIXTURE_HTML,
} from '../doc-frame-sdk-scenario.js';
import type { DocFrameSdkProbeInput } from '../doc-frame-sdk-probe.js';
const roots: string[] = [];
afterEach(async () => {
  configureDocFrameSdkProbe(undefined);
  interactionGate.reset();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'doc-sdk-scenario-')));
  roots.push(root);
  const gate = interactionGate;
  gate.reset();
  const ctx = gate.open('actual-chat');
  return { root, gate, ctx };
}
it('refuses an uninstalled test-boot probe without creating HTML or authority', async () => {
  const f = await setup();
  const scenario = docFrameSdkScenario('', f.ctx, { cwd: f.root });
  await expect(scenario.next()).rejects.toThrow('original-boot Doc SDK probe is unavailable');
  expect(await fs.readdir(f.root)).toEqual([]);
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});
it('uses the actual confined HTML, emits only safe readiness, and holds the workflow until the real step', async () => {
  const f = await setup();
  let source = '';
  let ended = false;
  const probe = vi.fn(async (input: DocFrameSdkProbeInput) => {
    source = input.sourcePath;
    expect(relative(f.root, source)).not.toMatch(/^\.\./);
    expect(await fs.readFile(source, 'utf8')).toBe(DOC_FRAME_SDK_FIXTURE_HTML);
    input.onReady({
      documentId: 'actual-returned-doc',
      eventType: 'fixture.changed',
      grantEvidence: 'verified_opener',
    });
    await input.waitForBrowser();
    ended = true;
  });
  configureDocFrameSdkProbe(probe);
  const scenario = docFrameSdkScenario('', f.ctx, { cwd: f.root });
  const first = await scenario.next();
  expect(first.value).toMatchObject({
    type: 'text_delta',
    data: { text: 'SDK fixture ready: actual-returned-doc; verified-opener log only.' },
  });
  expect(ended).toBe(false);
  expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
  expect(DOC_FRAME_SDK_FIXTURE_HTML).toContain("sdk.emit('fixture.changed', payload, { id })");
  expect(DOC_FRAME_SDK_FIXTURE_HTML).not.toContain("kind: 'granted'");
  const next = scenario.next();
  f.gate.step(f.ctx.sessionId);
  expect((await next).value).toMatchObject({ type: 'done' });
  await scenario.next();
  expect(ended).toBe(true);
  expect(await fs.readFile(source, 'utf8')).toBe(DOC_FRAME_SDK_FIXTURE_HTML);
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});
it('reports setup failure while waiting for readiness instead of hanging on a missing announcement', async () => {
  const f = await setup();
  configureDocFrameSdkProbe(async () => {
    throw new Error('genuine authority refusal');
  });
  await expect(docFrameSdkScenario('', f.ctx, { cwd: f.root }).next()).rejects.toThrow(
    'genuine authority refusal'
  );
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});
it('cancels an early generator return and waits for managed workflow cleanup', async () => {
  const f = await setup();
  let closed = false;
  configureDocFrameSdkProbe(async (input) => {
    input.onReady({
      documentId: 'doc',
      eventType: 'fixture.changed',
      grantEvidence: 'verified_opener',
    });
    try {
      await new Promise<never>((_yes, reject) =>
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
      );
    } finally {
      closed = true;
    }
  });
  const scenario = docFrameSdkScenario('', f.ctx, { cwd: f.root });
  await scenario.next();
  await expect(scenario.return(undefined)).rejects.toThrow('scenario ended');
  expect(closed).toBe(true);
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});
it('refuses a fixture directory symlink leaving the actual agent directory', async () => {
  const f = await setup(),
    other = await fs.mkdtemp(join(tmpdir(), 'doc-sdk-outside-'));
  roots.push(other);
  await fs.mkdir(join(f.root, '.dork'));
  await fs.symlink(other, join(f.root, '.dork', 'doc-sdk-fixture'));
  const probe = vi.fn(async () => {});
  configureDocFrameSdkProbe(probe);
  await expect(docFrameSdkScenario('', f.ctx, { cwd: f.root }).next()).rejects.toThrow(
    'leaves its agent'
  );
  expect(probe).not.toHaveBeenCalled();
  expect(await fs.readdir(other)).toEqual([]);
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});

it('refuses an outside .dork symlink before creating a child directory there', async () => {
  const f = await setup(),
    other = await fs.mkdtemp(join(tmpdir(), 'doc-sdk-parent-outside-'));
  roots.push(other);
  await fs.symlink(other, join(f.root, '.dork'));
  const probe = vi.fn(async () => {});
  configureDocFrameSdkProbe(probe);
  await expect(docFrameSdkScenario('', f.ctx, { cwd: f.root }).next()).rejects.toThrow(
    'leaves its agent'
  );
  expect(probe).not.toHaveBeenCalled();
  expect(await fs.readdir(other)).toEqual([]);
  f.gate.close(f.ctx.sessionId, f.ctx.token);
});
