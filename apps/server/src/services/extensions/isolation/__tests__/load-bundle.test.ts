/**
 * The injected `require` refuses `node:sqlite` only where it is told to
 * (DOR-3547): the isolated child passes the refused set, and in-process
 * extensions, which share the server's trust and some of which use it, keep
 * the built-in.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  createInjectedRequire,
  ISOLATED_REFUSED_BUILTINS,
  SQLITE_REFUSAL,
} from '../child/load-bundle.js';

const HERE = fileURLToPath(import.meta.url);

describe('createInjectedRequire', () => {
  it('refuses node:sqlite by both names when given the isolated set', () => {
    const req = createInjectedRequire({}, HERE, ISOLATED_REFUSED_BUILTINS);
    for (const name of ['node:sqlite', 'sqlite']) {
      expect(() => req(name)).toThrow(SQLITE_REFUSAL);
      try {
        req(name);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('ERR_EXTENSION_BUILTIN_REFUSED');
      }
    }
    // Other built-ins still load.
    expect(typeof (req('node:path') as { join: unknown }).join).toBe('function');
  });

  it('keeps node:sqlite for an in-process caller that refuses nothing', () => {
    const req = createInjectedRequire({}, HERE);
    expect(typeof (req('node:sqlite') as { DatabaseSync: unknown }).DatabaseSync).toBe('function');
  });
});
