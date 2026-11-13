import { describe, expect, it, vi } from 'vitest';
import { TabUrlPolicy } from '../url-policy.js';

const publicAddress = async () => ['93.184.216.34'];

describe('tab URL policy', () => {
  it('allows a public website', async () => {
    const policy = new TabUrlPolicy({ resolve: publicAddress });
    await expect(
      policy.assert('https://made-up.example/path?token=made-up')
    ).resolves.toMatchObject({ origin: 'https://made-up.example' });
  });

  it.each([
    'file:///etc/hosts',
    'data:text/html,private',
    'chrome://settings',
    'javascript:alert(1)',
    'not a URL',
    'https://name:password@made-up.example/',
  ])('refuses an unsupported or credential-bearing address: %s', async (url) => {
    const policy = new TabUrlPolicy({ resolve: publicAddress });
    await expect(policy.assert(url)).rejects.toMatchObject({ code: 'url_blocked' });
  });

  it('applies exact origin allows and blocks before resolving the host', async () => {
    const resolve = vi.fn(publicAddress);
    const policy = new TabUrlPolicy({
      resolve,
      allowedOrigins: ['https://made-up.example'],
      blockedOrigins: ['https://blocked.example'],
    });
    await expect(policy.assert('https://made-up.example/path')).resolves.toBeInstanceOf(URL);
    for (const url of [
      'https://made-up.example.attacker.example/',
      'http://made-up.example/',
      'https://made-up.example:8443/',
      'https://blocked.example/',
    ]) {
      await expect(policy.assert(url)).rejects.toMatchObject({ code: 'url_blocked' });
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    const blockedWins = new TabUrlPolicy({
      resolve,
      allowedOrigins: ['https://blocked.example'],
      blockedOrigins: ['https://blocked.example'],
    });
    await expect(blockedWins.assert('https://blocked.example/')).rejects.toMatchObject({
      code: 'url_blocked',
    });
    const emptyAllows = new TabUrlPolicy({ resolve, allowedOrigins: [] });
    await expect(emptyAllows.assert('https://made-up.example/')).rejects.toMatchObject({
      code: 'url_blocked',
    });
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
    '[100::1]',
    '[64:ff9b::7f00:1]',
    '[2001:db8::1]',
  ])('blocks private, local and reserved literals: %s', async (host) => {
    const resolve = vi.fn(publicAddress);
    const policy = new TabUrlPolicy({ resolve });
    await expect(policy.assert(`http://${host}/`)).rejects.toMatchObject({ code: 'url_blocked' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['93.184.216.34', '[2606:4700:4700::1111]', '[::ffff:93.184.216.34]'])(
    'allows public IP literals without a DNS call: %s',
    async (host) => {
      const resolve = vi.fn(publicAddress);
      const policy = new TabUrlPolicy({ resolve });
      await expect(policy.assert(`https://${host}/`)).resolves.toBeInstanceOf(URL);
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it('checks every DNS answer, every time, including a redirect’s destination', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['93.184.216.34', '127.0.0.1'])
      .mockResolvedValueOnce(['10.0.0.1']);
    const policy = new TabUrlPolicy({ resolve });
    await policy.assert('https://made-up.example/');
    await expect(policy.assert('https://made-up.example/redirected')).rejects.toMatchObject({
      code: 'url_blocked',
    });
    await expect(policy.assert('https://other.example/')).rejects.toMatchObject({
      code: 'url_blocked',
    });
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('fails closed on empty, malformed and failed DNS answers', async () => {
    for (const resolve of [
      async () => [],
      async () => ['not-an-ip'],
      async () => {
        throw new Error('made-up lookup detail');
      },
    ]) {
      const policy = new TabUrlPolicy({ resolve });
      await expect(
        policy.assert('https://made-up.example/private?token=made-up')
      ).rejects.toMatchObject({
        code: 'url_blocked',
        message: 'This address isn’t allowed for this tab. Ask the person to choose another site.',
      });
    }
  });

  it('lets the host explicitly allow private sites without weakening origin rules', async () => {
    const policy = new TabUrlPolicy({
      allowPrivateNetworks: true,
      allowedOrigins: ['http://127.0.0.1'],
    });
    await expect(policy.assert('http://127.0.0.1/')).resolves.toBeInstanceOf(URL);
    await expect(policy.assert('http://192.168.1.1/')).rejects.toMatchObject({
      code: 'url_blocked',
    });
  });

  it('runs the host’s page policy independently for each tab', async () => {
    const check = vi.fn((url: URL) => {
      if (url.hostname === 'protected.example') throw new Error('protected');
    });
    const policy = new TabUrlPolicy({ resolve: publicAddress, check });
    await expect(policy.assert('https://protected.example/')).rejects.toThrow('protected');
    await expect(policy.assert('https://made-up.example/')).resolves.toBeInstanceOf(URL);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
