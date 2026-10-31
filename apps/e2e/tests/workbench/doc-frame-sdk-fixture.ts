/** Installed SDK → original host port → actual HTTP/store; no page JSON is authority. */
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Frame, Page } from '@playwright/test';
import {
  CanvasChannelEventIdSchema,
  CanvasChannelJsonValueSchema,
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';
import { RightPanelPage } from '../../pages/RightPanelPage';

type Sdk = {
  status: string;
  emit(type: string, payload: unknown, options: { id: string }): Promise<unknown>;
  on(type: 'status', callback: (status: string) => void): () => void;
};
export type SdkWindow = Window & { dorkos?: { channel?: Sdk } };
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
}
function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a JSON string.');
  return value;
}
function parseOutput(value: unknown) {
  assertRecord(value);
  const payload = CanvasChannelJsonValueSchema.parse(value.payload);
  assertRecord(payload);
  return {
    id: CanvasChannelEventIdSchema.parse(value.id),
    payload: { text: stringValue(payload.text) },
    receipt: CanvasChannelEventReceiptSchema.parse(value.receipt),
  };
}
export const EVENT = 'fixture.changed';

/** Return the actual managed SDK iframe after its element becomes visible. */
export async function actualFrame(page: Page): Promise<Frame> {
  const locator = page.locator('iframe[title="SDK receipt fixture"]');
  await expect(locator).toBeVisible();
  const element = await locator.elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error('The real SDK frame is absent.');
  return frame;
}
/** Wait for the installed SDK to report its genuine host connection as ready. */
export async function ready(frame: Frame) {
  await expect
    .poll(() =>
      frame
        .evaluate(() => (window as SdkWindow).dorkos?.channel?.status ?? 'absent')
        // A page mid-reload has no context to read; that is "not yet", never a failure.
        .catch(() => 'navigating')
    )
    .toBe('ready');
}
/**
 * Seed a test-mode agent on the claude-code alias and pick the scenario its
 * first chat turn runs, through the ordinary manifest API.
 */
export async function seedScenario(request: APIRequestContext, scenario: string) {
  const seeded = await request.post('/api/test/seed-agent', { data: { instance: randomUUID() } });
  expect(seeded.ok(), 'The fixed SDK fixture requires the credential-free test-mode leg.').toBe(
    true
  );
  const seed: unknown = await seeded.json();
  assertRecord(seed);
  const agentDir = stringValue(seed.agentDir);
  const agentId = stringValue(seed.agentId);
  // The generic seed deliberately uses unavailable codex; this managed MCP turn
  // must share its real claude-code test alias with the registered agent.
  const updated = await request.patch(`/api/mesh/agents/${encodeURIComponent(agentId)}`, {
    data: { runtime: 'claude-code' },
  });
  expect(updated.ok()).toBe(true);
  expect(await updated.json()).toMatchObject({ id: agentId, runtime: 'claude-code' });
  const draftId = randomUUID();
  expect(
    (
      await request.post('/api/test/scenario', { data: { name: scenario, sessionId: draftId } })
    ).ok()
  ).toBe(true);
  return { agentDir, draftId };
}

/** Open the model-free managed document fixture through its normal chat flow. */
export async function open(page: Page, request: APIRequestContext) {
  const { agentDir, draftId } = await seedScenario(request, 'doc-frame-sdk-receipt');
  const chat = new ChatPage(page);
  await chat.goto(draftId, { dir: agentDir, runtime: 'claude-code', draft: true });
  await chat.sendAndLand('Open the genuine SDK receipt fixture');
  await expect(
    page.locator('[data-testid="message-item"][data-role="assistant"]').last()
  ).toContainText('SDK fixture ready:');
  const sessionId = new URL(page.url()).searchParams.get('session');
  if (!sessionId) throw new Error('The actual session is absent.');
  const documents = await request.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvas`);
  expect(documents.ok()).toBe(true);
  const listed: unknown = await documents.json();
  assertRecord(listed);
  if (!Array.isArray(listed.documents)) throw new Error('Expected the document list.');
  const matching = listed.documents
    .map((row: unknown) => {
      assertRecord(row);
      return { id: stringValue(row.id), title: stringValue(row.title) };
    })
    .filter((row) => row.title === 'SDK receipt fixture');
  expect(matching).toHaveLength(1);
  const documentId = matching[0]!.id;
  const panel = new RightPanelPage(page);
  await panel.selectView('Page previews');
  await page.getByRole('tab', { name: 'SDK receipt fixture', exact: true }).click();
  const frame = await actualFrame(page);
  await ready(frame);
  const servedSource = await page
    .locator('iframe[title="SDK receipt fixture"]')
    .getAttribute('src');
  expect(servedSource).toBeTruthy();
  const served = await request.get(servedSource!);
  expect(served.ok()).toBe(true);
  expect(served.headers()['content-type']).toContain('text/html');
  expect(await served.text()).toContain("Object.defineProperty(namespace,'channel'");
  const channelUrl = `/api/canvas/docs/${encodeURIComponent(documentId)}/channel`;
  const channel = async () => {
    const reply = await request.get(channelUrl);
    expect(reply.ok()).toBe(true);
    return CanvasChannelReplayResponseSchema.parse(await reply.json());
  };
  const receipt = async (id: string) => {
    const reply = await request.get(
      `/api/canvas/docs/${encodeURIComponent(documentId)}/events/${encodeURIComponent(id)}`
    );
    expect(reply.ok()).toBe(true);
    return CanvasChannelEventReceiptSchema.parse(await reply.json());
  };
  expect((await channel()).routing).toMatchObject({ enabled: true, approvedEventTypes: [EVENT] });
  return { chat, sessionId, documentId, frame, channel, receipt };
}
/** End the fixture's turn the normal way and leave the app. */
export async function finish(page: Page, request: APIRequestContext) {
  const sessionId = new URL(page.url()).searchParams.get('session');
  if (sessionId) {
    const step = await request.post('/api/test/step', { data: { sessionId } });
    expect(step.ok()).toBe(true);
    const stepped: unknown = await step.json();
    assertRecord(stepped);
    const released = stepped.released;
    if (typeof released !== 'boolean') throw new Error('Expected the step release flag.');
    const chat = new ChatPage(page);
    if (!released && (await chat.turnRunning.count()) > 0) {
      // Cleanup of an earlier setup/assertion failure uses the normal same-runtime interrupt.
      const interrupted = await request.post(
        `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`
      );
      expect(interrupted.ok()).toBe(true);
    }
    await chat.waitForTurnToEnd();
  }
  await page.goto('about:blank');
}
/** Preserve the first failure while finishing the genuine fixture turn and page. */
export async function preserveFailureAndFinish(
  page: Page,
  request: APIRequestContext,
  body: () => Promise<void>
) {
  let failure: unknown;
  try {
    await body();
  } catch (cause) {
    failure = cause;
  }
  try {
    await finish(page, request);
  } catch (cause) {
    failure ??= cause;
  }
  if (failure) throw failure;
}

/** Assert that the persisted delivery routed without creating a batch or turn. */
export function noTurn(receipt: ReturnType<typeof CanvasChannelEventReceiptSchema.parse>) {
  expect(receipt.deliveries).toHaveLength(1);
  expect(receipt.deliveries[0]).toMatchObject({
    status: 'routed',
    reason: 'no_turn',
    batchId: null,
    turnId: null,
  });
}
/** Click the real page control and validate its original event and receipt. */
export async function clickRecord(frame: Frame) {
  await frame.getByRole('button', { name: 'Record fixture event', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('"receipt"');
  return parseOutput(JSON.parse(await frame.locator('#status').innerText()));
}
