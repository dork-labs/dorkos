import { expect, it, onTestFinished, vi } from 'vitest';
import { configuration, deferred, fakePage, record, tick } from './parent-fixture.js';
import { closeRecord } from '../lifecycle/close.js';
import { validateEngineConfiguration } from '../configuration.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';
import { isOriginalTabLimitRefusal, trackPage } from '../tabs/registry.js';

const origin = 'http://127.0.0.1:9001';

it('registers the existing native census ceiling and permits duplicate observations at the ceiling', async () => {
  const owned = record();
  onTestFinished(async () => {
    await closeRecord(configuration(), owned);
  });
  const pages = Array.from({ length: 64 }, () => fakePage());
  const tabs = pages.map(({ page }) => trackPage(owned, page, origin, () => 0));
  expect(owned.tabs.size).toBe(64);
  expect(ordinaryRecord(owned)).toBe(true);
  expect(trackPage(owned, pages[0].page, origin, () => 0)).toBe(tabs[0]);
  expect(owned.tabs.size).toBe(64);
  expect(ordinaryRecord(owned)).toBe(true);
});

it('refuses the next original Page before its getters and joins held original context retirement', async () => {
  const owned = record();
  const originalContext = owned.context!;
  const close = deferred<void>();
  const originalClose = vi.fn(() => close.promise);
  originalContext.close = originalClose;
  onTestFinished(async () => {
    close.resolve();
    await closeRecord(configuration(), owned);
  });
  for (let i = 0; i < 64; i++) trackPage(owned, fakePage().page, origin, () => 0);
  const excess = fakePage();
  const read = vi.fn(() => {
    throw new Error('EXCESS_PAGE_GETTER');
  });
  Object.defineProperty(excess.raw, 'on', { get: read });
  let refusal: unknown;
  try {
    trackPage(owned, excess.page, origin, () => 0);
  } catch (value) {
    refusal = value;
  }
  expect(isOriginalTabLimitRefusal(refusal)).toBe(true);
  expect(ordinaryRecord(owned)).toBe(false);
  expect(owned.tabs.size).toBe(64);
  expect(read).not.toHaveBeenCalled();
  const returned = closeRecord(configuration(), owned);
  let settled = false;
  void returned.then(() => {
    settled = true;
  });
  await tick();
  expect(originalClose).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  close.resolve();
  await returned;
  expect(settled).toBe(true);
  expect(originalClose).toHaveBeenCalledTimes(1);
});

it.each([false, undefined, new Error('TAB_REGISTRATION_LIMIT')])(
  'does not classify a foreign producer failure as an original registration limit: %s',
  (value) => {
    expect(isOriginalTabLimitRefusal(value)).toBe(false);
  }
);

it('refuses a measured lower tab ceiling before excess Page getters while duplicate observation remains idempotent', async () => {
  const owned = record();
  owned.tabsPerBrowser = 2;
  onTestFinished(async () => {
    await closeRecord(configuration(), owned);
  });
  const first = fakePage(),
    second = fakePage(),
    excess = fakePage();
  const tab = trackPage(owned, first.page, origin, () => 0);
  trackPage(owned, second.page, origin, () => 0);
  expect(trackPage(owned, first.page, origin, () => 0)).toBe(tab);
  const read = vi.fn(() => {
    throw new Error('EXCESS_MEASURED_PAGE');
  });
  Object.defineProperty(excess.raw, 'on', { get: read });
  let reason: unknown;
  try {
    trackPage(owned, excess.page, origin, () => 0);
  } catch (value) {
    reason = value;
  }
  expect(isOriginalTabLimitRefusal(reason)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(owned.tabs.size).toBe(2);
  expect(ordinaryRecord(owned)).toBe(false);
});
it('reserves a measured tab slot before an original Page callback can reenter registration', async () => {
  const owned = record();
  owned.tabsPerBrowser = 1;
  onTestFinished(async () => {
    await closeRecord(configuration(), owned);
  });
  const original = fakePage(),
    reentrant = fakePage();
  let reason: unknown;
  original.raw.setDefaultTimeout.mockImplementation(() => {
    try {
      trackPage(owned, reentrant.page, origin, () => 0);
    } catch (value) {
      reason = value;
    }
  });
  trackPage(owned, original.page, origin, () => 0);
  expect(isOriginalTabLimitRefusal(reason)).toBe(true);
  expect(owned.tabs.size).toBe(1);
  expect(ordinaryRecord(owned)).toBe(false);
});

it.each([0, 65, 1.5, NaN])('refuses invalid original constructor tab ceiling %s', (limit) => {
  expect(() => validateEngineConfiguration({ ...configuration(), tabsPerBrowser: limit })).toThrow(
    'INVALID_CONFIGURATION'
  );
});
