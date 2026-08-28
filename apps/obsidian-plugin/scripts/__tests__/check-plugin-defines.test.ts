import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDefinesSubstituted,
  findUnsubstitutedDefines,
  parseInjectedGlobals,
} from '../check-plugin-defines';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The real declaration files the gate parses, so the pins below read the shipping lists. */
const CLIENT_GLOBALS_DTS = path.resolve(HERE, '../../../client/src/vite-env.d.ts');
const SERVER_VERSION_SOURCE = path.resolve(HERE, '../../../server/src/lib/version.ts');

const created: string[] = [];

/** A throwaway build output directory, cleaned up after each test. */
function distDir(assets: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-plugin-dist-'));
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

describe('the plugin define gate', () => {
  describe('the globals it checks for', () => {
    it('reads __APP_VERSION__ from the client’s own declaration file', () => {
      // The pin, not a fixture: `vite-env.d.ts` is what makes an unsubstituted
      // identifier compile, so if this gate ever stops finding names there it is
      // checking nothing at all.
      expect(
        parseInjectedGlobals(readFileSync(CLIENT_GLOBALS_DTS, 'utf-8'), CLIENT_GLOBALS_DTS)
      ).toContain('__APP_VERSION__');
    });

    it('reads __CLI_VERSION__ from the server’s version source', () => {
      // The second source this gate exists for: unlike the desktop renderer,
      // this plugin's build also has to satisfy a define the client never
      // declares, because it inlines apps/server/src/lib/version.ts whole.
      expect(
        parseInjectedGlobals(readFileSync(SERVER_VERSION_SOURCE, 'utf-8'), SERVER_VERSION_SOURCE)
      ).toContain('__CLI_VERSION__');
    });

    it('finds every declared global, once each', () => {
      const source = `declare global {
        const __APP_VERSION__: string;
        const __BUILD_ID__: string;
        const __APP_VERSION__: string;
      }`;

      expect(parseInjectedGlobals(source, 'fixture.d.ts')).toEqual([
        '__APP_VERSION__',
        '__BUILD_ID__',
      ]);
    });

    it('finds a module-local `declare const`, not just a `declare global` block', () => {
      // apps/server/src/lib/version.ts declares `__CLI_VERSION__` this way —
      // scoped to that module, not global — so the parser must not require the
      // `declare global` wrapper the client's file happens to use.
      const source = `declare const __CLI_VERSION__: string | undefined;`;

      expect(parseInjectedGlobals(source, 'fixture.ts')).toEqual(['__CLI_VERSION__']);
    });

    it('refuses a declaration file with none rather than passing forever after', () => {
      expect(() => parseInjectedGlobals('export {};', 'fixture.ts')).toThrow(/No __NAME__ globals/);
    });
  });

  describe('what counts as unsubstituted', () => {
    const names = ['__APP_VERSION__', '__CLI_VERSION__'];

    it('catches the bare identifier', () => {
      expect(findUnsubstitutedDefines('const b={buster:__APP_VERSION__};', names)).toEqual([
        '__APP_VERSION__',
      ]);
    });

    it('catches the server-only identifier the client never declares', () => {
      expect(
        findUnsubstitutedDefines('const v = typeof __CLI_VERSION__ !== "undefined";', names)
      ).toEqual(['__CLI_VERSION__']);
    });

    it('passes a substituted one', () => {
      expect(findUnsubstitutedDefines('const b={buster:"0.65.0"};', names)).toEqual([]);
    });

    it('is not fooled by a longer identifier that merely contains the name', () => {
      expect(findUnsubstitutedDefines('const x=my__APP_VERSION__2;', names)).toEqual([]);
      expect(findUnsubstitutedDefines('const x=__APP_VERSION__$b;', names)).toEqual([]);
    });
  });

  describe('reading an emitted bundle', () => {
    const names = ['__APP_VERSION__', '__CLI_VERSION__'];

    it('accepts a bundle whose defines were all substituted', () => {
      const dir = distDir({
        'main.js': 'const b={buster:"0.65.0",cli:"0.1.0"};',
        'styles.css': '.foo{color:red}',
      });

      expect(assertDefinesSubstituted(dir, names)).toBe(1);
    });

    it('rejects one that is not, naming the file and the identifier', () => {
      const dir = distDir({
        'main.js': 'const b={buster:__APP_VERSION__};',
      });

      expect(() => assertDefinesSubstituted(dir, names)).toThrow(
        /main\.js still contains __APP_VERSION__/
      );
    });

    it('rejects the plugin-only define just as readily as the client one', () => {
      // This is the case the desktop gate never had to handle: a define this
      // bundler alone must satisfy, not one shared with the client's other
      // two configs.
      const dir = distDir({
        'main.js': 'const v = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.1.0";',
      });

      expect(() => assertDefinesSubstituted(dir, names)).toThrow(
        /main\.js still contains __CLI_VERSION__/
      );
    });

    it('refuses an empty build rather than passing over nothing', () => {
      const dir = distDir({});

      expect(() => assertDefinesSubstituted(dir, names)).toThrow(/No \.js assets/);
    });

    it('says the same thing when the build is not there at all', () => {
      // The same mistake — no build, or a build somewhere else — so it reads as
      // one sentence rather than a raw ENOENT stack from the directory walk.
      const missing = path.join(distDir({}), 'never-built');

      expect(() => assertDefinesSubstituted(missing, names)).toThrow(/No \.js assets/);
    });
  });
});
