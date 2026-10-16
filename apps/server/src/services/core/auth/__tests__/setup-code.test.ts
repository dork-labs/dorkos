/**
 * @vitest-environment node
 *
 * The setup code (F5, DOR-2968): at least 40 bits, single use, an hour long,
 * printed to the terminal and a 0600 file only, never through the logger, and
 * capped on failures per address and overall.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ dorkHome: '' }));
vi.mock('../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => state.dorkHome }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkSetupCode,
  resetSetupCodeForTests,
  SETUP_CODE_FAILURE_WINDOW_MS,
  SETUP_CODE_MAX_FAILURES,
  SETUP_CODE_TTL_MS,
} from '../setup-code.js';
import { logger } from '../../../../lib/logger.js';

const T0 = 1_800_000_000_000;

/** Every line written to stdout while the test runs. */
let printed: string[];

function codeFile(): string {
  return path.join(state.dorkHome, 'setup-code');
}

/** The code as the file holds it (`XXXXX-XXXXX`). */
function currentCode(): string {
  return fs.readFileSync(codeFile(), 'utf8').trim();
}

describe('the setup code', () => {
  beforeEach(() => {
    state.dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-setup-code-'));
    resetSetupCodeForTests();
    vi.clearAllMocks();
    printed = [];
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(state.dorkHome, { recursive: true, force: true });
  });

  it('asks for a code the first time, printing one to the terminal and a 0600 file', () => {
    expect(checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0)).toBe('required');

    const code = currentCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(fs.statSync(codeFile()).mode & 0o777).toBe(0o600);
    expect(printed.join('')).toContain(code);
  });

  it('never sends the code through the logger', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const code = currentCode();
    const logged = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].flatMap(
        (fn) => vi.mocked(fn).mock.calls
      )
    );
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(code.replace('-', ''));
  });

  it('accepts the right code once, however it is typed, and then never again', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const code = currentCode();
    const typed = ` ${code.toLowerCase().replace('-', ' ')} `;

    expect(checkSetupCode({ code: typed, address: '10.0.0.2' }, T0 + 1000)).toBeNull();
    expect(fs.existsSync(codeFile())).toBe(false);
    // Spent: the same code is now wrong, and a fresh one has been printed.
    expect(checkSetupCode({ code, address: '10.0.0.2' }, T0 + 2000)).toBe('invalid');
    expect(currentCode()).not.toBe(code);
  });

  it('refuses a wrong code', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    expect(checkSetupCode({ code: '00000-00000', address: '10.0.0.2' }, T0)).toBe('invalid');
  });

  it('expires after an hour and prints a new code', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const code = currentCode();

    expect(checkSetupCode({ code, address: '10.0.0.2' }, T0 + SETUP_CODE_TTL_MS + 1)).toBe(
      'invalid'
    );
    expect(currentCode()).not.toBe(code);
  });

  it('accepts a code pasted with an en dash', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const pasted = currentCode().replace('-', '\u2013');
    expect(checkSetupCode({ code: pasted, address: '10.0.0.2' }, T0 + 1)).toBeNull();
  });

  it('slows everyone after too many wrong codes, from any address, and never swaps the code', () => {
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const code = currentCode();
    for (let i = 0; i < SETUP_CODE_MAX_FAILURES; i++) {
      expect(checkSetupCode({ code: 'WRONG-WRONG', address: `10.0.1.${i}` }, T0 + i)).toBe(
        'invalid'
      );
    }

    // Throttled for everyone, even with the right code, and nothing new is printed.
    printed = [];
    expect(checkSetupCode({ code, address: '10.0.2.1' }, T0 + 100)).toBe('too-many-attempts');
    expect(printed).toEqual([]);

    // Once the window passes, the SAME code still works: guessing cannot make it stale.
    expect(currentCode()).toBe(code);
    expect(
      checkSetupCode({ code, address: '10.0.2.1' }, T0 + SETUP_CODE_FAILURE_WINDOW_MS + 100)
    ).toBeNull();
  });

  it('prints only where the code is when stdout is not a terminal', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    checkSetupCode({ code: undefined, address: '10.0.0.2' }, T0);
    const code = currentCode();
    const output = printed.join('');

    expect(output).not.toContain(code);
    expect(output).toContain(codeFile());
  });
});
