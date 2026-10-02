import { BrowserManagerError } from './manager-error.mjs';
import { stopManagedBrowser, shutdownFailure } from './manager/manager-stop.mjs';
import { fixtureOrigin, startFixtureProxy } from './fixture-proxy.mjs';
import { dispatchManagedInput, resetManagedInput } from './manager-input.mjs';
import {
  clearManagedPointer,
  snapshotManagedPointer,
  dispatchWithManagedPointer,
} from './manager-pointer.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { validateFrameReceipt, validateRuntimeReceipt } from './contracts.mjs';
import {
  reserveProfile,
  prepareProfileRoot,
  chromiumHolder,
  ReservationError,
} from './profile-reservation.mjs';

export { BrowserManagerError } from './manager-error.mjs';

function viewport(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 4096 ||
    value.height > 4096
  )
    throw new BrowserManagerError('INVALID_VIEWPORT');
  return { width: value.width, height: value.height };
}

function failureCode(error, fallback) {
  return error instanceof BrowserManagerError || error instanceof ReservationError
    ? error.code
    : fallback;
}

/**
 * Own one actual headless Chromium context per running browser. Clean contexts use
 * newly created empty directories, never a signed-in storage seed. Views are external
 * references: no view subscription or disconnection can destroy browser work.
 */
export class BrowserManager {
  constructor({
    profilesDir,
    runtime,
    fixtureOrigin: injectedFixtureOrigin,
    viewport: initialViewport = { width: 1280, height: 720 },
    diagnosticLimit = 100,
  }) {
    validateRuntimeReceipt(runtime.receipt);
    if (
      runtime.launchOptions.executablePath !== runtime.receipt.executablePath ||
      runtime.launchOptions.headless !== true
    )
      throw new BrowserManagerError('UNPINNED_RUNTIME');
    if (!Number.isSafeInteger(diagnosticLimit) || diagnosticLimit < 1 || diagnosticLimit > 1000)
      throw new BrowserManagerError('INVALID_DIAGNOSTIC_LIMIT');
    this.fixtureOrigin = fixtureOrigin(injectedFixtureOrigin);
    this.profilesDir = prepareProfileRoot(profilesDir);
    this.runtime = runtime;
    this.proxyPromise = null;
    this.viewport = viewport(initialViewport);
    this.diagnosticLimit = diagnosticLimit;
    this.browsers = new Map();
    this.tabs = new Map();
    this.opening = new Set();
    this.stopping = false;
  }

  async verifyExecutable() {
    try {
      await access(this.runtime.receipt.executablePath, constants.R_OK | constants.X_OK);
      if (!(await stat(this.runtime.receipt.executablePath)).isFile()) throw new Error();
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.runtime.receipt.executablePath))
        hash.update(chunk);
      if (hash.digest('hex') !== this.runtime.receipt.executableSha256) throw new Error();
    } catch {
      throw new BrowserManagerError('EXECUTABLE_UNAVAILABLE');
    }
  }

  /** Each reopen retains its profile ID but gets new browser and tab lifetime IDs. */
  openPersistent(profileId) {
    return this.open({ profileId, mode: 'persistent' });
  }

  /** Switching to clean mode leaves every durable browser running and available. */
  openClean() {
    return this.open({ profileId: null, mode: 'clean' });
  }

  async open({ profileId, mode }) {
    if (this.stopping) throw new BrowserManagerError('MANAGER_STOPPED');
    const operation = this.start({ profileId, mode });
    this.opening.add(operation);
    try {
      return await operation;
    } finally {
      this.opening.delete(operation);
    }
  }

  async start({ profileId, mode }) {
    await this.verifyExecutable();
    this.proxyPromise ??= startFixtureProxy(this.fixtureOrigin);
    const proxy = await this.proxyPromise;
    let reservation;
    let profileDir;
    let context;
    let record;
    let launchEntered = false;
    try {
      if (mode === 'persistent') {
        reservation = reserveProfile(this.profilesDir, profileId);
        reservation.createDirectory();
        profileDir = reservation.profileDir;
      } else profileDir = await mkdtemp(join(this.profilesDir, '.clean-'));
      // A crash during launch leaves an explicit unknown browser holder requiring manual repair.
      reservation?.beginLaunch();
      launchEntered = true;
      context = await this.runtime.chromium.launchPersistentContext(profileDir, {
        ...this.runtime.launchOptions,
        proxy: { server: proxy.server, bypass: '<-loopback>' },
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        viewport: this.viewport,
        timeout: 10_000,
      });
      const browserId = `browser-${randomUUID()}`;
      const ownedProcess = chromiumHolder(profileDir);
      if (!ownedProcess) throw new BrowserManagerError('PROCESS_IDENTITY_UNAVAILABLE');
      record = {
        browserId,
        profileId,
        mode,
        profileDir,
        context,
        reservation,
        status: 'running',
        process: ownedProcess,
        tabIds: new Set(),
        closePromise: null,
      };
      this.browsers.set(browserId, record);
      reservation?.recordBrowser(ownedProcess);
      context.on('page', (page) => this.trackPage(record, page));
      for (const page of context.pages()) this.trackPage(record, page);
      if (!record.tabIds.size) this.trackPage(record, await context.newPage());
      context.on('close', () => {
        record.status = 'stopped';
        for (const id of record.tabIds) {
          const tab = this.tabs.get(id);
          if (tab) {
            tab.closed = true;
            clearManagedPointer(tab);
          }
        }
      });
      return this.browserInfo(record);
    } catch (error) {
      let cleanupFailure;
      try {
        if (record) await this.closeBrowser(record.browserId);
        else {
          if (context) await context.close();
          if (reservation) reservation.release();
          else if (profileDir && !launchEntered)
            await rm(profileDir, { recursive: true, force: true });
          else if (profileDir) throw new BrowserManagerError('PROCESS_IDENTITY_UNAVAILABLE');
        }
      } catch (failure) {
        cleanupFailure = failure;
      }
      try {
        if (
          this.opening.size <= 1 &&
          ![...this.browsers.values()].some((record) => record.status === 'running')
        ) {
          const pendingProxy = this.proxyPromise;
          this.proxyPromise = null;
          if (pendingProxy) await (await pendingProxy).close();
        }
      } catch (failure) {
        cleanupFailure ??= failure;
      }
      if (cleanupFailure) {
        // Fixed codes retain both outcomes without preserving arbitrary launch/stderr payloads.
        const failure = new BrowserManagerError('LAUNCH_CLEANUP_FAILED');
        failure.primaryCode = failureCode(error, 'LAUNCH_FAILED');
        failure.cleanupCode = failureCode(cleanupFailure, 'CLEANUP_FAILED');
        throw failure;
      }
      if (error?.code) throw error;
      throw new BrowserManagerError('LAUNCH_FAILED');
    }
  }

  browserInfo(record) {
    return {
      browserId: record.browserId,
      profileId: record.profileId,
      mode: record.mode,
      status: record.status,
      tabIds: [...record.tabIds],
    };
  }

  /** Metadata contains no URL or page-world assertion of identity. */
  listBrowsers() {
    return [...this.browsers.values()].map((record) => this.browserInfo(record));
  }

  trackPage(browser, page) {
    if ([...browser.tabIds].some((id) => this.tabs.get(id)?.page === page)) return;
    const tabId = `tab-${randomUUID()}`;
    const tab = {
      tabId,
      browserId: browser.browserId,
      profileId: browser.profileId,
      page,
      navigationGeneration: 0,
      viewportVersion: 1,
      viewport: { ...this.viewport },
      captureSequence: 0,
      closed: false,
      diagnostics: [],
      droppedDiagnostics: 0,
      diagnosticSequence: 0,
      buttons: new Set(),
      keys: new Set(),
      composition: false,
      touchActive: false,
      cdp: null,
      captureTail: Promise.resolve(),
      pendingCaptures: 0,
    };
    this.tabs.set(tabId, tab);
    browser.tabIds.add(tabId);
    page.setDefaultTimeout(1500);
    page.setDefaultNavigationTimeout(1500);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        tab.navigationGeneration++;
        clearManagedPointer(tab);
        // Only the initial empty page is browser-internal; all meaningful content
        // comes from the injected fixture. Off-origin responses never reached a site.
        if (frame.url() !== 'about:blank' && !this.allowedUrl(frame.url()))
          page.close().catch(() => {});
      }
    });
    page.on('close', () => {
      tab.closed = true;
      clearManagedPointer(tab);
    });
    page.on('console', (message) => this.recordDiagnostic(tab, `console-${message.type()}`));
    page.on('pageerror', () => this.recordDiagnostic(tab, 'page-error'));
    const requestGenerations = new WeakMap();
    page.on('request', (request) =>
      requestGenerations.set(
        request,
        tab.navigationGeneration +
          (request.isNavigationRequest() && request.frame() === page.mainFrame() ? 1 : 0)
      )
    );
    page.on('requestfailed', (request) =>
      this.recordDiagnostic(tab, 'network-error', requestGenerations.get(request))
    );
    page.on('response', (response) => {
      if (response.status() >= 400)
        this.recordDiagnostic(tab, 'http-error', requestGenerations.get(response.request()));
    });
  }

  recordDiagnostic(tab, kind, generation = tab.navigationGeneration) {
    if (tab.diagnostics.length === this.diagnosticLimit) {
      tab.diagnostics.shift();
      tab.droppedDiagnostics++;
    }
    tab.diagnostics.push({
      kind,
      tabId: tab.tabId,
      navigationGeneration: generation,
      sequence: ++tab.diagnosticSequence,
    });
  }

  /** Bounded diagnostics deliberately exclude raw console text and network bodies. */
  diagnostics(tabId) {
    const tab = this.requireTab(tabId);
    return {
      entries: tab.diagnostics.map((entry) => ({ ...entry })),
      dropped: tab.droppedDiagnostics,
    };
  }

  requireTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.closed || this.browsers.get(tab.browserId)?.status !== 'running')
      throw new BrowserManagerError('TAB_UNAVAILABLE');
    return tab;
  }

  /** Internal trusted callers receive the canonical Page; never expose it remotely. */
  getTab(tabId) {
    const tab = this.requireTab(tabId);
    return {
      tabId,
      browserId: tab.browserId,
      profileId: tab.profileId,
      page: tab.page,
      navigationGeneration: tab.navigationGeneration,
      viewportVersion: tab.viewportVersion,
      viewport: { ...tab.viewport },
    };
  }

  /** Popups acquire distinct IDs without changing a caller's selected tab. */
  listTabs(browserId) {
    const browser = this.browsers.get(browserId);
    if (!browser) throw new BrowserManagerError('BROWSER_UNAVAILABLE');
    return [...browser.tabIds]
      .filter((id) => !this.tabs.get(id).closed)
      .map((id) => this.getTab(id));
  }

  /** Resize is explicit canonical state, never inferred from a viewer's dimensions. */
  resize(tabId, dimensions) {
    const tab = this.requireTab(tabId);
    const next = viewport(dimensions);
    clearManagedPointer(tab);
    const operation = tab.captureTail.then(async () => {
      await tab.page.setViewportSize(next);
      tab.viewport = next;
      tab.viewportVersion++;
      clearManagedPointer(tab);
      return this.getTab(tabId);
    });
    tab.captureTail = operation.catch(() => {});
    return operation;
  }

  /** Capture bytes from the exact target Page; navigation during capture fails closed. */
  capture(tabId, { epoch = 0 } = {}) {
    const tab = this.requireTab(tabId);
    if (tab.pendingCaptures >= 2) throw new BrowserManagerError('CAPTURE_BUSY');
    tab.pendingCaptures++;
    const operation = tab.captureTail.then(async () => {
      this.requireTab(tabId);
      const generation = tab.navigationGeneration;
      const version = tab.viewportVersion;
      const pointer = snapshotManagedPointer(tab),
        pointerGeneration = tab.pointerGeneration;
      const bytes = await tab.page.screenshot({
        type: 'jpeg',
        quality: 70,
        timeout: 1500,
        animations: 'disabled',
        caret: 'initial',
      });
      if (generation !== tab.navigationGeneration || version !== tab.viewportVersion)
        throw new BrowserManagerError('STALE_CAPTURE');
      const receipt = validateFrameReceipt({
        kind: 'frame',
        browserId: tab.browserId,
        tabId,
        navigationGeneration: generation,
        viewportVersion: version,
        epoch,
        captureSequence: ++tab.captureSequence,
        ...tab.viewport,
        byteLength: bytes.length,
      });
      return {
        receipt,
        bytes,
        pointer: pointerGeneration === tab.pointerGeneration ? pointer : null,
      };
    });
    tab.captureTail = operation.catch(() => {});
    return operation.finally(() => {
      tab.pendingCaptures--;
    });
  }

  /** Control owns serialization/epochs; AbortSignal prevents only unstarted dispatch. */
  async dispatchInput(tabId, action, { signal } = {}) {
    if (signal?.aborted) throw new BrowserManagerError('ACTION_ABORTED');
    const tab = this.requireTab(tabId);
    return dispatchWithManagedPointer(tab, action, () =>
      dispatchManagedInput(tab, action, (value) => this.allowedUrl(value))
    );
  }

  allowedUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === this.fixtureOrigin && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  /** Release tracked held input after the control queue barrier, before granting input. */
  async resetInput(tabId) {
    const tab = this.requireTab(tabId);
    clearManagedPointer(tab);
    return resetManagedInput(tab);
  }

  /** Read-only canonical pointer metadata adds no input authority. */
  pointerSnapshot(tabId) {
    return snapshotManagedPointer(this.requireTab(tabId));
  }

  /** Local process identity supports precise orphan observations without broad kills. */
  ownedProcess(browserId) {
    const record = this.browsers.get(browserId);
    if (!record) throw new BrowserManagerError('BROWSER_UNAVAILABLE');
    return record.process ? { ...record.process } : null;
  }

  /** Closing twice shares one promise; reservations release only after Chromium exits. */
  closeBrowser(browserId) {
    const record = this.browsers.get(browserId);
    if (!record) return Promise.resolve();
    for (const id of record.tabIds ?? []) clearManagedPointer(this.tabs.get(id));
    record.closePromise ??= this.stop(record).catch((error) => {
      record.closePromise = null;
      throw error;
    });
    return record.closePromise;
  }

  async stop(record) {
    await stopManagedBrowser(record);
  }

  /** Await concurrent launches before closing; shutdown never silently abandons a launch. */
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([...this.opening]);
    const browserIds = [...this.browsers.keys()];
    const outcomes = await Promise.allSettled(browserIds.map((id) => this.closeBrowser(id)));
    if (this.proxyPromise) {
      const proxy = await this.proxyPromise;
      await proxy.close();
    }
    const failure = shutdownFailure(browserIds, outcomes);
    if (failure) throw failure;
  }
}
