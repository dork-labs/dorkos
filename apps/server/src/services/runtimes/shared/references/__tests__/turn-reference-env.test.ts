/**
 * `DORKOS_API_URL` (DOR-5264): the server that started a turn, as a loopback
 * origin built from its own bind and port, and nothing else: never a LAN or
 * named host, and never on a hub or an agent computer.
 */
import { describe, expect, it } from 'vitest';
import { loopbackServerOrigin, TURN_REFERENCE_ENV_NAMES } from '../turn-reference-env.js';

describe('loopbackServerOrigin', () => {
  it.each([
    ['localhost', 'http://localhost:6241'],
    ['0.0.0.0', 'http://localhost:6241'],
    ['::', 'http://localhost:6241'],
    ['127.0.0.1', 'http://127.0.0.1:6241'],
    ['::1', 'http://[::1]:6241'],
  ])('a person’s computer bound to %s answers %s', (bind, origin) => {
    expect(loopbackServerOrigin('computer', bind, 6241)).toBe(origin);
  });

  it.each(['192.168.1.20', '10.0.0.4', 'my-mac.local', 'dorkos.example.com', 'fe80::1'])(
    'is unset for a bind that is not loopback: %s',
    (bind) => {
      expect(loopbackServerOrigin('computer', bind, 6241)).toBeUndefined();
    }
  );

  it.each(['hub', 'agent-computer'])('is unset on a %s', (role) => {
    expect(loopbackServerOrigin(role, 'localhost', 6241)).toBeUndefined();
  });

  it('is unset for a port that is not one', () => {
    for (const port of [0, -1, 70000, Number.NaN]) {
      expect(loopbackServerOrigin('computer', 'localhost', port)).toBeUndefined();
    }
  });

  it('rides the turn allow-list and the relaunch fingerprint’s skip list with the other references', () => {
    expect(TURN_REFERENCE_ENV_NAMES).toContain('DORKOS_API_URL');
  });
});
