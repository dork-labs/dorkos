/**
 * Moving a fetch handler's `location` under its mount (DOR-2857): the handler
 * lives below `/api/ext/<id>`, so its own paths are the mount's.
 */
import { describe, expect, it } from 'vitest';
import { mountedLocation } from '../reply-headers.js';

const MOUNT = '/api/ext/my-ext';
const HANDLER_URL = 'http://localhost:4242/items/7?page=2';

describe('mountedLocation', () => {
  it.each([
    ['an absolute path', '/done?x=1#top', '/api/ext/my-ext/done?x=1#top'],
    ['a relative path', 'next', '/api/ext/my-ext/items/next'],
    ['a parent path', '../all', '/api/ext/my-ext/all'],
    ['a full URL on its own origin', 'http://localhost:4242/done', '/api/ext/my-ext/done'],
    ['a climb past its root', '/../../api/config', '/api/ext/my-ext/api/config'],
  ])('moves %s under the mount', (_label, value, expected) => {
    expect(mountedLocation(value, HANDLER_URL, MOUNT)).toBe(expected);
  });

  it.each([
    ['another site', 'https://evil.example/x'],
    ['a protocol-relative host', '//evil.example/x'],
    ['another port', 'http://localhost:9999/x'],
  ])('leaves %s alone, for the rule to drop', (_label, value) => {
    expect(mountedLocation(value, HANDLER_URL, MOUNT)).toBe(value);
  });

  it('reads a backslash as nothing', () => {
    expect(mountedLocation('/\\evil.example', HANDLER_URL, MOUNT)).toBeNull();
  });
});
