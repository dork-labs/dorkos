import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDefinesSubstituted,
  findUnsubstitutedDefines,
  parseInjectedGlobals,
} from '../check-renderer-defines';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The real declaration file the gate parses, so the pin below reads the shipping list. */
const CLIENT_GLOBALS_DTS = path.resolve(HERE, '../../../client/src/vite-env.d.ts');

const created: string[] = [];

/** A throwaway renderer output directory, cleaned up after each test. */
function rendererDir(assets: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-renderer-'));
  created.push(dir);
  for (const [name, source] of Object.entries(assets)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the renderer define gate', () => {
  describe('the globals it checks for', () => {
    it('reads them from the client’s own declaration file', () => {
      // The pin, not a fixture: `vite-env.d.ts` is what makes an unsubstituted
      // identifier compile, so if this gate ever stops finding names there it is
      // checking nothing at all.
      expect(parseInjectedGlobals(readFileSync(CLIENT_GLOBALS_DTS, 'utf-8'))).toContain(
        '__APP_VERSION__'
      );
    });

    it('finds every declared global, once each', () => {
      const dts = `declare global {
        const __APP_VERSION__: string;
        const __BUILD_ID__: string;
        const __APP_VERSION__: string;
      }`;

      expect(parseInjectedGlobals(dts)).toEqual(['__APP_VERSION__', '__BUILD_ID__']);
    });

    it('refuses a declaration file with none rather than passing forever after', () => {
      expect(() => parseInjectedGlobals('export {};')).toThrow(/No __NAME__ globals/);
    });
  });

  describe('what counts as unsubstituted', () => {
    const names = ['__APP_VERSION__'];

    it('catches the bare identifier', () => {
      expect(findUnsubstitutedDefines('const b={buster:__APP_VERSION__};', names)).toEqual([
        '__APP_VERSION__',
      ]);
    });

    it('passes a substituted one', () => {
      expect(findUnsubstitutedDefines('const b={buster:"0.63.1"};', names)).toEqual([]);
    });

    it('is not fooled by a longer identifier that merely contains the name', () => {
      expect(findUnsubstitutedDefines('const x=my__APP_VERSION__2;', names)).toEqual([]);
      expect(findUnsubstitutedDefines('const x=__APP_VERSION__$b;', names)).toEqual([]);
    });
  });

  describe('reading an emitted bundle', () => {
    const names = ['__APP_VERSION__'];

    it('accepts a bundle whose defines were all substituted', () => {
      const dir = rendererDir({
        'assets/index-abc.js': 'const b={buster:"0.63.1"};',
        'assets/vendor-def.js': 'export const x=1;',
      });

      expect(assertDefinesSubstituted(dir, names)).toBe(2);
    });

    it('rejects one that is not, naming the file and the identifier', () => {
      // Exactly what v0.63.0 shipped: the web config substituted the define and
      // electron-vite's renderer section, having no `define` block, did not.
      const dir = rendererDir({
        'assets/index-abc.js': 'const b={buster:__APP_VERSION__};',
      });

      expect(() => assertDefinesSubstituted(dir, names)).toThrow(
        /assets\/index-abc\.js still contains __APP_VERSION__/
      );
    });

    it('refuses an empty build rather than passing over nothing', () => {
      const dir = rendererDir({});

      expect(() => assertDefinesSubstituted(dir, names)).toThrow(/No \.js assets/);
    });

    it('says the same thing when the build is not there at all', () => {
      // The same mistake — no build, or a build somewhere else — so it reads as
      // one sentence rather than a raw ENOENT stack from the directory walk.
      const missing = path.join(rendererDir({}), 'never-built');

      expect(() => assertDefinesSubstituted(missing, names)).toThrow(/No \.js assets/);
    });

    it('reads the emitted scripts, not the shell around them', () => {
      // The renderer's code all lands in `.js` assets — the entry script in
      // `index.html` is emitted as one — so the walk stays on files that can
      // actually evaluate an identifier.
      const dir = rendererDir({
        'index.html': '<script type="module" src="/assets/index-abc.js"></script>',
        'assets/index-abc.js': 'const b={buster:"0.63.1"};',
      });

      expect(assertDefinesSubstituted(dir, names)).toBe(1);
    });
  });
});
