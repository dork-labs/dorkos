import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  DRIVING_BUTTON,
  openInCanvasBrowser,
  startDrivingFixtureServer,
} from '../../pages/canvas-dev-server';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { ChatPage } from '../../pages/ChatPage';

/**
 * Recording a run, in a real browser (spec `canvas-agent-seat` §3).
 *
 * **Half of this feature only exists in a browser and cannot be reached from a
 * server test at all.** The frames are rasterized inside the previewed page, the
 * window keeps them, `gifenc` encodes them there, and the finished file is
 * uploaded back. jsdom has no canvas and never decodes an image, so every server
 * and client unit test stops at the edges of that: the state machine on one side
 * and the encoder on the other. What this spec adds is the middle — that the
 * round trip really produces a file, and that the bytes at the path the agent
 * was given really parse as a GIF.
 *
 * It runs on the test-mode leg, and that is a safety property rather than a
 * convenience: it drives a turn, and on the ordinary leg that turn would be a
 * real, billable one.
 */
// Its own timeout, because this turn is genuinely long: the window rasterizes a
// frame per action, encodes them all after the stop, and uploads the result —
// on top of a real page load and a dev-server preview handshake. The suite's 30s
// default expired mid-encode and reported it as "the agent never answered".
test.describe.configure({ timeout: 120_000 });

test.describe('Browser — an agent records what it did @smoke', () => {
  let fixture: Server;
  let fixturePort: number;
  let agentDir: string;

  test.beforeAll(async () => {
    const started = await startDrivingFixtureServer();
    fixture = started.server;
    fixturePort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });

  /** Select the recording scenario and seed a working directory to record into. */
  async function selectRecordingScenario(page: Page): Promise<void> {
    const reset = await page.request.post('/api/test/reset');
    if (reset.status() === 404) {
      throw new Error(
        'This spec is running against a leg with no TestModeRuntime. It drives a turn, so ' +
          'on that leg it would start a real, billable one. Run it in the ' +
          '`chromium-browser-driving` project.'
      );
    }
    const res = await page.request.post('/api/test/scenario', {
      data: { name: 'browser-recording' },
    });
    expect(res.ok(), `could not select the recording scenario: ${await res.text()}`).toBe(true);

    // The recording lands under this directory, so the turn needs one — and the
    // spec needs to know which one, to read the file back.
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok(), 'could not seed an agent to record in').toBe(true);
    agentDir = ((await seeded.json()) as { agentDir: string }).agentDir;
  }

  /** Open the fixture page in the Browser tab and wait for its shim to connect. */
  async function openFixture(page: Page, sessionId: string): Promise<void> {
    const rightPanel = new RightPanelPage(page);
    const claims: { active?: boolean; instrumented?: boolean }[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/devtools/ingest')) return;
      const body = request.postDataJSON() as { active?: boolean; instrumented?: boolean } | null;
      if (body && body.active !== undefined) claims.push(body);
    });

    await openInCanvasBrowser(
      page,
      rightPanel,
      `http://localhost:${fixturePort}/`,
      sessionId,
      agentDir
    );
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(frame.getByRole('button', { name: DRIVING_BUTTON })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => claims.some((claim) => claim.active === true && claim.instrumented === true), {
        timeout: 15_000,
      })
      .toBe(true);
  }

  test('records the run, saves a real GIF, and answers with its last frame', async ({ page }) => {
    const sessionId = randomUUID();
    await selectRecordingScenario(page);
    await openFixture(page, sessionId);

    const chat = new ChatPage(page);
    await chat.sendAndLand('record what you do', 90_000);
    const answer = page.locator('[data-testid="message-item"][data-role="assistant"]').last();
    await expect(answer).toContainText('stop-path:', { timeout: 90_000 });
    const text = await answer.innerText();

    // The recording really ran: the start took, the actions in between worked,
    // and the stop came back with a file rather than a refusal.
    expect(text).toContain('start: Started recording.');
    expect(text).toContain(`click: Clicked button "${DRIVING_BUTTON}".`);

    const path = /stop-path: (\S+)/.exec(text)?.[1];
    const frames = Number(/stop-frames: (\d+)/.exec(text)?.[1]);
    expect(path, `the stop answer named no file:\n${text}`).toBeTruthy();
    // Under the session's own working directory, in the directory `.gitignore`
    // already covers — never a path the agent or the page chose.
    expect(path!.startsWith('.dork/.temp/recordings/')).toBe(true);
    expect(path!.endsWith('.gif')).toBe(true);
    // A frame on start, one per action that captured, one on stop.
    expect(frames).toBeGreaterThanOrEqual(2);
    // The picture that came back is the LAST FRAME as a PNG, never the GIF.
    expect(text).toContain('stop-keyframe: image/png');

    // And the bytes at that path really are a GIF. Read back through the file
    // route, which resolves the path inside the same working directory — so
    // this is the file on disk rather than the answer repeating itself.
    const file = await page.request.get(
      `/api/files/raw?cwd=${encodeURIComponent(agentDir)}&path=${encodeURIComponent(path!)}`
    );
    expect(file.ok(), `could not read the recording back: ${file.status()}`).toBe(true);
    const bytes = Buffer.from(await file.body());
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
