/* global window */
import assert from 'node:assert/strict';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../manager.mjs';
import { startViewer } from '../viewer.mjs';
import { PrototypeControl } from '../control.mjs';
import { chromiumHolder, processIdentity } from '../profile-reservation.mjs';
import {
  processTable,
  ownedTree,
  signalOwned,
  awaitGone,
  distribution,
} from './resource-process.mjs';
import { delay } from '../durability-helpers.mjs';

function host() {
  const times = cpus().map((cpu) => cpu.times);
  return {
    idle: times.reduce((sum, entry) => sum + entry.idle, 0),
    all: times.reduce((sum, entry) => sum + Object.values(entry).reduce((a, b) => a + b, 0), 0),
    freeMiB: freemem() / 1048576,
    load: loadavg()[0],
  };
}
function group(root, table, inventory, rootOnly = false) {
  const rows = rootOnly
    ? table.filter((row) => row.pid === root.pid && row.birth === root.birth && !row.zombie)
    : ownedTree(root, table);
  if (!rows.length || processIdentity(root.pid)?.birth !== root.birth)
    throw Error('OWNED_ROOT_UNAVAILABLE');
  for (const row of rows) inventory.set(`${row.pid}-${row.birth}`, row);
  return rows;
}
function deltaCPU(before, after, elapsedMs) {
  let delta = 0;
  for (const row of after) {
    const previous = before.find((old) => old.pid === row.pid && old.birth === row.birth);
    if (previous) delta += Math.max(0, row.cpuSeconds - previous.cpuSeconds);
  }
  return (delta * 100000) / elapsedMs;
}
async function phase({
  name,
  roots,
  inventory,
  durationMs,
  intervalMs,
  bytes,
  frames,
  streamBytes = null,
}) {
  const values = { 'host-cpu': [], 'host-free': [], 'host-load': [], bandwidth: [], frames: [] };
  if (streamBytes) for (const key of Object.keys(streamBytes())) values[key + '-bandwidth'] = [];
  for (const key of Object.keys(roots)) {
    values[key + '-cpu'] = [];
    values[key + '-rss'] = [];
  }
  let table = processTable();
  let previous = Object.fromEntries(
    Object.entries(roots).map(([key, root]) => [key, group(root, table, inventory, key === 'node')])
  );
  let beforeHost = host(),
    beforeBytes = bytes(),
    beforeFrames = frames(),
    beforeAt = performance.now();
  let beforeStreams = streamBytes?.();
  const started = beforeAt,
    startedAt = new Date().toISOString();
  const intervals = [];
  while (performance.now() - started < durationMs) {
    await delay(intervalMs);
    const now = performance.now(),
      elapsed = now - beforeAt;
    intervals.push(elapsed);
    table = processTable();
    for (const [key, root] of Object.entries(roots)) {
      const rows = group(root, table, inventory, key === 'node');
      // Node role excludes descendants: browser and viewer trees have their own separate totals.
      const selected = key === 'node' ? rows.filter((row) => row.pid === root.pid) : rows;
      values[key + '-cpu'].push(deltaCPU(previous[key], selected, elapsed));
      values[key + '-rss'].push(selected.reduce((sum, row) => sum + row.rssMiB, 0));
      previous[key] = selected;
    }
    const currentHost = host();
    if (currentHost.all <= beforeHost.all) throw Error('HOST_CPU_UNAVAILABLE');
    values['host-cpu'].push(
      (1 - (currentHost.idle - beforeHost.idle) / (currentHost.all - beforeHost.all)) * 100
    );
    values['host-free'].push(currentHost.freeMiB);
    values['host-load'].push(currentHost.load);
    const nextBytes = bytes(),
      nextFrames = frames();
    values.bandwidth.push(((nextBytes - beforeBytes) * 1000) / elapsed);
    if (streamBytes) {
      const current = streamBytes();
      for (const key of Object.keys(current))
        values[key + '-bandwidth'].push(((current[key] - beforeStreams[key]) * 1000) / elapsed);
      beforeStreams = current;
    }
    values.frames.push(nextFrames - beforeFrames);
    beforeHost = currentHost;
    beforeBytes = nextBytes;
    beforeFrames = nextFrames;
    beforeAt = now;
  }
  return {
    name,
    startedAt,
    durationMs: performance.now() - started,
    sampleCount: intervals.length,
    measurements: [
      distribution(name + '-interval', 'ms', intervals),
      ...Object.entries(values).map(([key, samples]) =>
        distribution(
          name + '-' + key,
          key.endsWith('rss') || key === 'host-free'
            ? 'MiB'
            : key.endsWith('cpu')
              ? 'percent'
              : key.endsWith('bandwidth')
                ? 'bytes/s'
                : 'count',
          samples
        )
      ),
    ],
  };
}

/** Measure actual two-browser/two-viewer roles in coordinated quiet windows, never enforce invented resource thresholds. */
export async function sampleResources({
  runtime,
  profilesDir,
  fixture,
  durationMs = 15_000,
  intervalMs = 1000,
}) {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 60_000 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 200 ||
    intervalMs > 2000
  )
    throw TypeError('INVALID_SAMPLE_WINDOW');
  const inventory = new Map();
  const nodeRoot = processIdentity(process.pid);
  const measurements = [];
  const phases = [];
  let frontend, viewer;
  let payloadBytes = 0,
    delivered = 0;
  const manager = new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
  const viewerBytes = [0, 0],
    viewerFrames = [0, 0];
  const measure = async (name, roots, streaming = false) => {
    const result = await phase({
      name,
      roots: { node: nodeRoot, ...roots },
      inventory,
      durationMs,
      intervalMs,
      bytes: () => payloadBytes,
      frames: () => delivered,
      streamBytes: streaming ? () => ({ viewerA: viewerBytes[0], viewerB: viewerBytes[1] }) : null,
    });
    phases.push({
      name,
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      sampleCount: result.sampleCount,
    });
    measurements.push(...result.measurements);
  };
  try {
    await measure('baseline', {});
    const browsers = await Promise.all(
      ['resource-A', 'resource-B'].map((id) => manager.openPersistent(id))
    );
    const tabs = browsers.map((browser) => manager.getTab(browser.tabIds[0]));
    await Promise.all(
      tabs.map((tab, index) => tab.page.goto(fixture.url + '/?marker=resource-' + index))
    );
    const roots = {
      browserA: manager.ownedProcess(browsers[0].browserId),
      browserB: manager.ownedProcess(browsers[1].browserId),
    };
    for (const root of Object.values(roots)) inventory.set(`${root.pid}-${root.birth}`, root);
    await measure('idle', roots);
    viewer = await startViewer({
      manager,
      createControl: (origin) =>
        new PrototypeControl({ manager, origin, fixtureOrigin: fixture.url }),
      frameIntervalMs: 80,
    });
    const frontDir = join(profilesDir, 'frontend');
    frontend = await runtime.chromium.launchPersistentContext(frontDir, runtime.launchOptions);
    const viewerRoot = chromiumHolder(frontDir);
    assert.ok(viewerRoot?.birth, 'viewer Chromium root identity is measured separately');
    inventory.set(`${viewerRoot.pid}-${viewerRoot.birth}`, viewerRoot);
    const viewers = await Promise.all(
      tabs.map(async (tab, index) => {
        const credential = viewer.control.issueParticipant({
          actorId: 'resource-observer-' + index,
          kind: 'human',
          tabIds: [tab.tabId],
        });
        const page = await frontend.newPage();
        page.on('response', async (response) => {
          if (new URL(response.url()).pathname !== '/frame' || response.status() !== 200) return;
          try {
            const bytes = (await response.body()).byteLength;
            if (bytes > 0) {
              payloadBytes += bytes;
              delivered++;
              viewerBytes[index] += bytes;
              viewerFrames[index]++;
            }
          } catch {
            /* A disconnected or failed response is not counted as delivered. */
          }
        });
        await page.goto(viewer.url);
        await page.evaluate((config) => globalThis.viewer.connect(config), {
          token: credential,
          tabId: tab.tabId,
        });
        await page.waitForFunction(() => Boolean(globalThis.viewer.current()), { timeout: 5000 });
        return page;
      })
    );
    const before = delivered,
      beforeViewerFrames = [...viewerFrames];
    await measure('viewing', { ...roots, viewer: viewerRoot }, true);
    assert.ok(
      viewerFrames.every((count, index) => count > beforeViewerFrames[index]),
      'each viewer must deliver fresh frame bodies during viewing'
    );
    assert.ok(
      delivered > before && viewer.stats().rendered > 0,
      'two real viewers must consume and acknowledge frames'
    );
    await Promise.all(
      tabs.map((tab) =>
        tab.page.evaluate(() => {
          globalThis.workTimer = setInterval(() => window.fixture.increment(), 25);
        })
      )
    );
    const beforeActive = delivered,
      beforeActiveViewerFrames = [...viewerFrames];
    await measure('active', { ...roots, viewer: viewerRoot }, true);
    assert.ok(
      viewerFrames.every((count, index) => count > beforeActiveViewerFrames[index]),
      'both active viewers must deliver fresh frames'
    );
    assert.ok(delivered > beforeActive);
    for (const tab of tabs)
      assert.ok((await tab.page.evaluate(() => window.fixture.readState())).revision > 0);
    await Promise.all(viewers.map((page) => page.evaluate(() => globalThis.viewer.disconnect())));
    await Promise.all(
      tabs.map((tab) => tab.page.evaluate(() => clearInterval(globalThis.workTimer)))
    );
    await frontend.close();
    frontend = null;
    await viewer.close();
    viewer = null;
    await manager.shutdown();
    const browserInventory = [...inventory.values()].filter((entry) => entry.pid !== nodeRoot.pid);
    await awaitGone(browserInventory);
    await measure('after', {});
    return {
      subjectIds: [
        ...browsers.map((browser) => browser.browserId),
        `node-${nodeRoot.pid}`,
        `frontend-${viewerRoot.pid}`,
        'viewer-A',
        'viewer-B',
      ],
      samples: phases.reduce((sum, entry) => sum + entry.sampleCount, 0),
      measurements,
      phases,
      candidates: deriveCandidateCaps({
        measurements,
        cores: cpus().length,
        totalMiB: totalmem() / 1048576,
      }),
      host: { cores: cpus().length, totalMiB: totalmem() / 1048576 },
      payloadBytes,
      frames: delivered,
      viewerFrames,
    };
  } finally {
    await frontend?.close().catch(() => {});
    await viewer?.close().catch(() => {});
    await manager.shutdown().catch(() => {});
    for (const owned of inventory.values())
      if (owned.pid !== nodeRoot.pid) signalOwned(owned, 'SIGKILL');
    const remaining = [...inventory.values()].filter((owned) => owned.pid !== nodeRoot.pid);
    if (remaining.length) await awaitGone(remaining);
  }
}

/** Derive conservative additional capacity from measured pressure and explicit half-host reserve assumptions. */
export function deriveCandidateCaps({ measurements, cores, totalMiB }) {
  const metric = (name) => {
    const value = measurements.find((entry) => entry.name === name);
    if (!value || value.sampleCount < 1) throw Error('CAP_METRIC_UNAVAILABLE');
    return value;
  };
  const browserMiB = Math.max(metric('active-browserA-rss').p95, metric('active-browserB-rss').p95);
  const browserCPU = Math.max(metric('active-browserA-cpu').p95, metric('active-browserB-cpu').p95);
  const baselineNonfreeMiB = totalMiB - metric('baseline-host-free').min;
  const baselineCPUPercent = metric('baseline-host-cpu').p95;
  const memoryBudget = Math.max(0, totalMiB * 0.5 - baselineNonfreeMiB);
  const cpuBudget = cores * Math.max(0, 50 - baselineCPUPercent);
  if (!(browserMiB > 0) || !Number.isFinite(browserCPU)) throw Error('CAP_METRIC_UNAVAILABLE');
  const memoryCandidate = Math.max(
    0,
    Math.floor(
      (memoryBudget - metric('active-node-rss').p95 - metric('active-viewer-rss').p95) / browserMiB
    )
  );
  // Zero measured browser CPU does not establish a capacity bound; no CPU-based slot is recommended.
  const cpuCandidate =
    browserCPU > 0
      ? Math.max(
          0,
          Math.floor(
            (cpuBudget - metric('active-node-cpu').p95 - metric('active-viewer-cpu').p95) /
              browserCPU
          )
        )
      : null;
  const browsers = Math.min(2, memoryCandidate, cpuCandidate ?? 0);
  return {
    browsers,
    viewers: browsers > 0 ? 2 : 0,
    memoryCandidate,
    cpuCandidate,
    baselineNonfreeMiB,
    baselineCPUPercent,
    reserveRAMFraction: 0.5,
    reserveCPUFraction: 0.5,
  };
}
