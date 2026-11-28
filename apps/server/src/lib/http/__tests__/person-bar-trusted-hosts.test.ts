/**
 * The person bar also accepts a page served at a host listed in
 * `DORKOS_TRUSTED_HOSTS` (Security's ruling on DOR-4986): the exact name, over
 * `https`, or over `http` only at a loopback or private address. Nothing else
 * about the bar moves: an agent, an approval token and `Origin: null` stay
 * refused, and login on still wants the owner's cookie.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonBarCopy } from '@dorkos/shared/capabilities';
import { env } from '../../../env.js';
import type { RequestFacts } from '../../../http/request-facts.js';
import type { RequestUser } from '../../../services/core/auth/session-gate.js';
import { configManager, initConfigManager } from '../../../services/core/config-manager.js';
import { logger } from '../../logger.js';
import { assessPerson, isTrustedHostOrigin, logPersonBarTrustedHosts } from '../person-bar.js';

const COPY: PersonBarCopy = {
  code: 'person_only',
  subject: 'the fixture',
  agent: 'Only a person can do this.',
};
const LISTED = 'dorkos.example.com, 192.168.1.5, nas.example.org';

let home: string;
const original = env.DORKOS_TRUSTED_HOSTS;

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-bar-hosts-')));
  initConfigManager(home);
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  configManager.set('auth', { enabled: false });
  env.DORKOS_TRUSTED_HOSTS = LISTED;
});
afterEach(() => {
  env.DORKOS_TRUSTED_HOSTS = original;
});

/** The bar's verdict on a request from this computer: `null`, or the refusal's code and detail. */
function verdict(headers: Record<string, string>, user?: RequestUser) {
  const facts: RequestFacts = {
    headers: { host: 'localhost', ...headers },
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    method: 'POST',
    ingress: 'direct',
    user,
    agentIdentity: undefined,
  };
  const refusal = assessPerson(facts, COPY);
  return refusal && { code: refusal.body.code, detail: refusal.body.detail };
}

const CROSS_SITE = { code: 'person_only', detail: 'Open this from the DorkOS app.' };
/** The owner's browser session: a page at another address is another device, which the gate asks for one. */
const OWNER: RequestUser = { userId: 'owner', credential: 'cookie' };

describe('a listed host', () => {
  it('admits a page served over https at a listed name', () => {
    expect(verdict({ origin: 'https://dorkos.example.com' }, OWNER)).toBeNull();
  });

  it('admits plain http only at a listed private address', () => {
    expect(verdict({ origin: 'http://192.168.1.5:4242' }, OWNER)).toBeNull();
  });

  it.each([
    ['an unlisted host', 'https://other.example.com'],
    ['a suffix of a listed name', 'https://evil.dorkos.example.com'],
    ['a listed name inside another', 'https://dorkos.example.com.evil.example'],
    ['http at a listed public name', 'http://dorkos.example.com'],
    ['http at a listed name that is not an address', 'http://nas.example.org'],
  ])('refuses %s', (_name, origin) => {
    expect(verdict({ origin }, OWNER)).toEqual(CROSS_SITE);
  });

  it('refuses an agent and an approval token from a listed origin', () => {
    const origin = 'https://dorkos.example.com';
    for (const header of ['x-dorkos-agent', 'x-dorkos-approval']) {
      expect(verdict({ origin, [header]: 'token' }, OWNER)).toEqual({
        code: 'person_only',
        detail: COPY.agent,
      });
    }
  });

  it('refuses Origin: null even when "null" is listed', () => {
    env.DORKOS_TRUSTED_HOSTS = `${LISTED}, null`;
    expect(verdict({ origin: 'null' }, OWNER)).toEqual(CROSS_SITE);
  });

  it('refuses a key-only caller with login on from a listed origin', () => {
    configManager.set('auth', { enabled: true });
    const refused = verdict(
      { origin: 'https://dorkos.example.com', authorization: 'Bearer made-up-key' },
      { userId: 'owner', credential: 'api-key' }
    );
    expect(refused?.code).toBe('person_only');
    expect(refused?.detail).toMatch(/^Only a person signed in to DorkOS/);
  });
});

describe('isTrustedHostOrigin', () => {
  it('matches the exact origin form only', () => {
    const hosts = ['dorkos.example.com'];
    expect(isTrustedHostOrigin('https://dorkos.example.com', hosts)).toBe(true);
    expect(isTrustedHostOrigin('https://dorkos.example.com/path', hosts)).toBe(false);
    expect(isTrustedHostOrigin('ftp://dorkos.example.com', hosts)).toBe(false);
    expect(isTrustedHostOrigin('http://[fd00::1]:4242', ['fd00::1'])).toBe(true);
    expect(isTrustedHostOrigin('http://8.8.8.8', ['8.8.8.8'])).toBe(false);
  });
});

describe('the boot line', () => {
  it('names a listed host written with a port, which never matches, once', () => {
    env.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com, nas.example.org:4242, [fd00::1]:4242';
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logPersonBarTrustedHosts();
    logPersonBarTrustedHosts();
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"nas.example.org:4242": host:4242 never matches');
    expect(lines[1]).toContain('"[fd00::1]:4242"');
    warn.mockRestore();
  });
});
