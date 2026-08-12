import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ID_STORAGE_KEY_FOR_TEST, resolveStableClientId } from '../client-id';
import { HttpTransport } from '../http-transport';

const BASE_URL = 'http://localhost:4242/api';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('resolveStableClientId', () => {
  it('reuses the persisted id across a refresh of the same tab', () => {
    // First load mints and persists.
    const first = resolveStableClientId();
    expect(first).toMatch(/^web-/);
    expect(sessionStorage.getItem(CLIENT_ID_STORAGE_KEY_FOR_TEST)).toBe(first);

    // A refresh reruns resolution against the SAME (surviving) sessionStorage.
    const afterRefresh = resolveStableClientId();
    expect(afterRefresh).toBe(first);
  });

  it('mints a fresh id for a genuinely new tab (empty sessionStorage)', () => {
    const first = resolveStableClientId();
    sessionStorage.clear(); // a new tab starts with empty sessionStorage
    const newTab = resolveStableClientId();
    expect(newTab).toMatch(/^web-/);
    expect(newTab).not.toBe(first);
  });

  it('re-mints when the stored value is not a web client id', () => {
    sessionStorage.setItem(CLIENT_ID_STORAGE_KEY_FOR_TEST, 'garbage');
    const resolved = resolveStableClientId();
    expect(resolved).toMatch(/^web-/);
    expect(resolved).not.toBe('garbage');
  });

  it('falls back to a fresh unpersisted id when sessionStorage getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const resolved = resolveStableClientId();
    expect(resolved).toMatch(/^web-/);
  });

  it('falls back to a fresh unpersisted id when sessionStorage setItem throws (private mode quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const a = resolveStableClientId();
    const b = resolveStableClientId();
    expect(a).toMatch(/^web-/);
    expect(b).toMatch(/^web-/);
    // Nothing was persisted, so each call mints its own id — never crashes.
    expect(a).not.toBe(b);
  });
});

describe('HttpTransport clientId stability', () => {
  it('keeps the same clientId when the transport is reconstructed in the same tab', () => {
    // Two constructions against one shared sessionStorage simulate a refresh:
    // the app boot recreates HttpTransport but the tab (and its storage) survive.
    const before = new HttpTransport(BASE_URL);
    const afterRefresh = new HttpTransport(BASE_URL);
    expect(before.clientId).toMatch(/^web-/);
    expect(afterRefresh.clientId).toBe(before.clientId);
  });
});
