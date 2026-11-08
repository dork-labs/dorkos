/**
 * Security proof tests for PR #3543 (DOR-3957), M1 at the server's load-time scrub.
 * Temp dirs and made-up cookie values only. Copy to
 * apps/server/src/services/browser/__tests__/ to run.
 *
 * The "GAP" tests assert what a correct strip must do; at 4fdc0f90bf they FAIL,
 * which is the proof. chromium-canon.mjs shows bundled Chromium sends each of
 * these cookies to http://127.0.0.1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudOriginEntries } from '@dorkos/shared/cloud-origin';
import { localAppHosts } from '@dorkos/shared/app-origin';
import { scrubAgentBrowserState } from '../agent-browser-guard.js';

const entries = cloudOriginEntries();
const appHosts = localAppHosts('test-mac.lan', { lo0: [{ address: '127.0.0.1', family: 'IPv4' }] });
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3543-'));
  file = path.join(dir, 'storage-state.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(cookie: Record<string, unknown>) {
  fs.writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        {
          name: 'better-auth.session_token',
          value: 'FAKE-OWNER-SESSION',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
          ...cookie,
        },
      ],
      origins: [],
    })
  );
}
const leftInFile = () => fs.readFileSync(file, 'utf8').includes('FAKE-OWNER-SESSION');

describe('cookie-only DorkOS session (no page storage)', () => {
  it.each([
    'localhost',
    '.localhost',
    '127.0.0.1',
    'LocalHost.',
    '[::1]',
    'test-mac.local',
    '.lan',
  ])('owned file: %s is scrubbed', (domain) => {
    seed({ domain });
    expect(scrubAgentBrowserState(file, { entries, appHosts, owned: true })).toBe('scrubbed');
    expect(leftInFile()).toBe(false);
  });
  it('foreign file: refused and untouched', () => {
    seed({ domain: 'localhost' });
    const before = fs.readFileSync(file, 'utf8');
    expect(scrubAgentBrowserState(file, { entries, appHosts, owned: false })).toBe('refused');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('GAP: forms Playwright loads that the scrub keeps', () => {
  it.each([
    ['url only, no domain', { url: 'http://127.0.0.1:4242/' }],
    ['IPv4 shorthand 127.1', { domain: '127.1' }],
    ['IPv4 decimal', { domain: '2130706433' }],
    ['IPv4 hex', { domain: '0x7f.0.0.1' }],
  ])('%s must not survive the scrub', (_label, cookie) => {
    seed(cookie);
    const outcome = scrubAgentBrowserState(file, { entries, appHosts, owned: true });
    expect(outcome).not.toBe('clean');
    expect(leftInFile()).toBe(false);
  });
  it('a foreign file with a url-only DorkOS cookie must be refused', () => {
    seed({ url: 'http://localhost:4242/' });
    expect(scrubAgentBrowserState(file, { entries, appHosts, owned: false })).toBe('refused');
  });
});
