import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { BrowserManager } from '../manager.mjs';
import { resolve, dirname, basename } from 'node:path';
import { PrototypeControl } from '../control.mjs';
import { startFixture } from '../fixture.mjs';
import { startViewer } from '../viewer.mjs';
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function distribution(name, unit, samples) {
  assert.ok(samples.length > 0);
  const sorted = samples.toSorted((a, b) => a - b);
  assert.ok(sorted.every((n) => Number.isFinite(n) && n >= 0));
  return {
    name,
    unit,
    sampleCount: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
export async function environment({ runtime, profilesDir, controlClass = PrototypeControl }) {
  const cleanup = [];
  const close = async () => {
    const errors = [];
    for (const fn of cleanup.splice(0).reverse()) {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'MECHANICS_CLEANUP_FAILED');
  };
  try {
    await mkdir(profilesDir, { recursive: true, mode: 0o700 });
    const fixture = await startFixture();
    cleanup.push(() => fixture.close());
    const manager = new BrowserManager({
      runtime,
      profilesDir,
      fixtureOrigin: fixture.url,
      diagnosticLimit: 20,
    });
    cleanup.push(() => manager.shutdown());
    const browser = await manager.openClean();
    const tab = manager.getTab(browser.tabIds[0]);
    await tab.page.goto(fixture.url + '/?marker=MECHANICS-A');
    const viewer = await startViewer({
      manager,
      frameIntervalMs: 40,
      createControl: (origin) =>
        new controlClass({ manager, origin, fixtureOrigin: fixture.url, maxQueue: 8 }),
    });
    cleanup.push(() => viewer.close());
    const frontend = await runtime.chromium.launch(runtime.launchOptions);
    cleanup.push(() => frontend.close());
    const control = viewer.control;
    const agent = control.issueParticipant({
      actorId: 'mechanics-agent',
      kind: 'agent',
      tabIds: [tab.tabId],
      canControl: true,
    });
    const human = control.issueParticipant({
      actorId: 'mechanics-human',
      kind: 'human',
      tabIds: [tab.tabId],
      canControl: true,
    });
    await control.acquire(agent, tab.tabId).barrier;
    let sequence = 0;
    const request = (action) => ({
      requestId: `mechanics-${++sequence}`,
      tabId: tab.tabId,
      navigationGeneration: manager.getTab(tab.tabId).navigationGeneration,
      viewportVersion: manager.getTab(tab.tabId).viewportVersion,
      epoch: control.state(tab.tabId).epoch,
      action,
    });
    const submit = (participant, action) => control.submit(participant, request(action));
    async function open(participant = human) {
      const page = await frontend.newPage({ viewport: { width: 1400, height: 1200 } });
      await page.goto(viewer.url);
      await page.evaluate(({ token, tabId }) => globalThis.viewer.connect({ token, tabId }), {
        token: participant,
        tabId: tab.tabId,
      });
      await page.waitForFunction(() => globalThis.viewer.current()?.captureSequence > 0);
      return page;
    }
    return {
      runtime,
      fixture,
      manager,
      browser,
      tab,
      viewer,
      frontend,
      control,
      agent,
      human,
      request,
      submit,
      open,
      close,
    };
  } catch (error) {
    await closePreservingError(close, error);
    throw error;
  }
}
export async function center(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
export async function viewerPoint(page, tab, selector) {
  await page.locator('#screen').scrollIntoViewIfNeeded();
  const target = await center(tab.page, selector);
  const canvas = await page.locator('#screen').boundingBox();
  return {
    x: canvas.x + (target.x * canvas.width) / tab.viewport.width,
    y: canvas.y + (target.y * canvas.height) / tab.viewport.height,
  };
}
/** Only the intended observation assertion can certify a negative control. */
export function assertObservation(condition, failureCode) {
  if (condition) return;
  const error = new assert.AssertionError({
    message: failureCode,
    actual: false,
    expected: true,
    operator: '===',
  });
  error.failureCode = failureCode;
  throw error;
}
/** Preserve the primary failure and attach cleanup evidence; standalone cleanup failures still throw. */
export async function cleanupLifo(cleanups, primary) {
  const errors = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) return;
  const combined = [
    ...(primary?.cleanupErrors ?? (primary?.cleanupError ? [primary.cleanupError] : [])),
    ...errors,
  ];
  const failure =
    combined.length === 1 ? combined[0] : new AggregateError(combined, 'Mechanics cleanup failed');
  if (!primary) throw failure;
  primary.cleanupFailure = true;
  primary.cleanupErrors = combined;
  primary.cleanupError = failure;
}
export async function closePreservingError(close, primary) {
  await cleanupLifo([close], primary);
}
export async function withCleanup(run, close) {
  let primary;
  try {
    return await run();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await closePreservingError(close, primary);
  }
}

async function canonicalDirectory(path) {
  let candidate = resolve(path);
  const suffix = [];
  for (;;) {
    try {
      return resolve(await realpath(candidate), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(basename(candidate));
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}
export async function assertSeparateDirectories(profilesDir, artifactDir) {
  const profiles = await canonicalDirectory(profilesDir),
    artifacts = await canonicalDirectory(artifactDir);
  if (
    profiles === artifacts ||
    profiles.startsWith(artifacts + '/') ||
    artifacts.startsWith(profiles + '/')
  )
    throw TypeError('SEPARATE_ARTIFACT_DIRECTORY_REQUIRED');
}
