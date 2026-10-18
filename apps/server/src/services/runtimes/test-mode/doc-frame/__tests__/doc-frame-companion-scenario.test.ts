/** The companion scenario's branching; the real flow is the browser-driving e2e. */
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { interactionGate } from '../../interaction-gate.js';
import { configureDocFrameSdkProbe } from '../doc-frame-sdk-scenario.js';
import {
  COMPANION_DOC_TURN_PREFIX,
  COMPANION_PAGE_HTML,
  COMPANION_ROUTE,
  docFrameCompanionScenario,
} from '../doc-frame-companion-scenario.js';
import type { DocFrameSdkProbeInput } from '../doc-frame-sdk-probe.js';

const roots: string[] = [];
afterEach(async () => {
  configureDocFrameSdkProbe(undefined);
  interactionGate.reset();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function setup(docEventsPrompt?: string) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'doc-companion-')));
  roots.push(root);
  interactionGate.reset();
  const ctx = { ...interactionGate.open('companion-chat'), docEventsPrompt };
  return { root, ctx };
}
async function drain(generator: AsyncGenerator<unknown>) {
  const out = [];
  for await (const event of generator) out.push(event);
  return out;
}

it('a turn started by a page event echoes the doc_events it was handed and calls no tools', async () => {
  const probe = vi.fn();
  configureDocFrameSdkProbe(probe);
  const f = await setup('<doc_events>companion.click 1234</doc_events>');
  const events = await drain(docFrameCompanionScenario('', f.ctx, { cwd: f.root }));
  expect(events[0]).toMatchObject({
    type: 'text_delta',
    data: { text: `${COMPANION_DOC_TURN_PREFIX}\n\n<doc_events>companion.click 1234</doc_events>` },
  });
  expect(events.at(-1)).toMatchObject({ type: 'done' });
  expect(probe).not.toHaveBeenCalled();
  expect(await fs.readdir(f.root)).toEqual([]);
});

it('the setup turn refuses without a dev server URL before writing anything', async () => {
  configureDocFrameSdkProbe(vi.fn());
  const f = await setup();
  await expect(
    drain(docFrameCompanionScenario('show the companion', f.ctx, { cwd: f.root }))
  ).rejects.toThrow('dev server URL');
  expect(await fs.readdir(f.root)).toEqual([]);
});

it('opens both pages with the companion route, says so, and approves only after the browser step', async () => {
  const f = await setup();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let stepped = false;
  configureDocFrameSdkProbe(async (input: DocFrameSdkProbeInput) => {
    expect(await fs.readFile(input.sourcePath, 'utf8')).toBe(COMPANION_PAGE_HTML);
    let next = 0;
    await input.workflow!({
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'approve_doc_route') {
          expect(stepped).toBe(true);
          return { kind: 'granted', grantId: `grant-${args.documentId as string}` };
        }
        return { success: true, documentId: `doc-${++next}` };
      },
      grant: (grantId) =>
        ({
          documentId: grantId.replace('grant-', ''),
          approvalId: null,
          approvalEvidence: { kind: 'verified_opener' },
        }) as never,
      waitForBrowser: async () => {
        await input.waitForBrowser();
        stepped = true;
      },
    });
  });
  const scenario = docFrameCompanionScenario('at http://localhost:5173/', f.ctx, { cwd: f.root });
  expect((await scenario.next()).value).toMatchObject({
    data: { text: 'Companion pages open: doc-1 doc-2.\n\n' },
  });
  const rest = drain(scenario);
  interactionGate.step(f.ctx.sessionId);
  const events = await rest;
  expect(events[0]).toMatchObject({ data: { text: 'Companion routes approved.\n\n' } });
  expect(events.at(-1)).toMatchObject({ type: 'done' });
  const navigations = calls.filter((call) => call.name === 'control_ui');
  expect(navigations.map((call) => call.args.url)).toEqual([
    expect.stringMatching(/\.html$/),
    'http://localhost:5173/',
  ]);
  for (const call of navigations)
    expect(call.args).toMatchObject({
      action: 'browser_navigate',
      channel: { routes: [COMPANION_ROUTE] },
    });
  expect(calls.filter((call) => call.name === 'approve_doc_route')).toHaveLength(2);
});
