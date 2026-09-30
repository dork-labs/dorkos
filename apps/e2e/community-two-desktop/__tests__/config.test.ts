import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_VARIABLE,
  OPT_IN_VARIABLE,
  readHandoff,
  readRunConfig,
  type HandoffFs,
} from '../config.js';

const mac = { os: 'darwin' as const, arch: 'arm64' };

const HANDOFF_PATH = '/private/held/handoff.json';
const validHandoff = {
  origin: 'https://community.example.test',
  communityId: '7d9f1f7e-9a55-4d0f-8d1e-7f7c8c1c2a10',
  channelId: '2b0c3c1e-6a3e-4a7c-9f2d-0f6f0c8a9b11',
  owner: { email: 'owner@example.test', password: 'owner-secret-password' },
  member: { email: 'member@example.test', password: 'member-secret-password' },
  inviteLink: 'https://community.example.test/c/7d9f/join#invite=token',
};

/** A fake file system holding one handoff file, with the modes a test chooses. */
function fakeFs(
  body: unknown = validHandoff,
  o: { fileMode?: number; dirMode?: number; isFile?: boolean; link?: boolean } = {}
): HandoffFs {
  return {
    open: () => {
      if (o.link) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      return {
        isFile: () => o.isFile ?? true,
        mode: 0o100000 | (o.fileMode ?? 0o600),
        read: () => (typeof body === 'string' ? body : JSON.stringify(body)),
        close: () => undefined,
      };
    },
    stat: () => ({ isDirectory: () => true, mode: 0o040000 | (o.dirMode ?? 0o700) }),
  };
}

describe('two-Desktop acceptance config', () => {
  it('refuses to run unless the opt-in variable is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(() => readRunConfig({ [OPT_IN_VARIABLE]: value }, [], mac)).toThrow(/Refusing to run/);
  });

  it('runs once opted in, borrowing nothing and building nothing by default', () => {
    const config = readRunConfig({ [OPT_IN_VARIABLE]: '1' }, [], mac);
    expect(config.build).toBe(false);
    expect(config.postgresContainer).toBeNull();
    expect(config.executablePath).toMatch(
      /release\/mac-arm64\/DorkOS\.app\/Contents\/MacOS\/DorkOS$/
    );
  });

  it('builds when asked by flag or variable', () => {
    expect(readRunConfig({ [OPT_IN_VARIABLE]: '1' }, ['--build'], mac).build).toBe(true);
    expect(
      readRunConfig({ [OPT_IN_VARIABLE]: '1', DORKOS_TWO_DESKTOP_BUILD: '1' }, [], mac).build
    ).toBe(true);
  });

  it('refuses the default app path off macOS Apple Silicon unless an app is named', () => {
    const linux = { os: 'linux' as const, arch: 'x64' };
    expect(() => readRunConfig({ [OPT_IN_VARIABLE]: '1' }, [], linux)).toThrow(
      /DORKOS_TWO_DESKTOP_APP/
    );
    expect(
      readRunConfig(
        { [OPT_IN_VARIABLE]: '1', DORKOS_TWO_DESKTOP_APP: '/opt/dorkos/DorkOS' },
        [],
        linux
      ).executablePath
    ).toBe('/opt/dorkos/DorkOS');
  });

  it('a local run starts its own infrastructure and has no remote community', () => {
    // Guards the default: without a handoff nothing changes for the local run.
    const config = readRunConfig({ [OPT_IN_VARIABLE]: '1' }, [], mac);
    expect(config.remote).toBeNull();
    expect(config.startsInfra).toBe(true);
  });

  it('never reads the handoff unless the run was opted into', () => {
    // Catches a reorder that would open a credential file before the opt-in check.
    const fs = fakeFs();
    let reads = 0;
    const counting: HandoffFs = { ...fs, open: (file) => (reads++, fs.open(file)) };
    expect(() => readRunConfig({ [HANDOFF_VARIABLE]: HANDOFF_PATH }, [], mac, counting)).toThrow(
      /Refusing to run/
    );
    expect(reads).toBe(0);
  });
});

describe('two-Desktop remote mode (the live gate handoff)', () => {
  const env = { [OPT_IN_VARIABLE]: '1', [HANDOFF_VARIABLE]: HANDOFF_PATH };

  it('accepts a private, complete https handoff and disables the infrastructure', () => {
    // The happy path: remote mode is on and starts no Postgres or Community server.
    const config = readRunConfig(env, [], mac, fakeFs());
    expect(config.remote).toEqual(validHandoff);
    expect(config.startsInfra).toBe(false);
  });

  it('refuses a handoff file anyone but its owner can read', () => {
    // Catches a gate or a person loosening the file that holds two passwords.
    for (const fileMode of [0o644, 0o640, 0o604, 0o700, 0o400])
      expect(() => readRunConfig(env, [], mac, fakeFs(validHandoff, { fileMode }))).toThrow(
        /must be 0600/
      );
  });

  it('refuses a handoff in a directory others can enter', () => {
    // Catches a handoff dropped into a shared folder such as /tmp.
    for (const dirMode of [0o755, 0o750, 0o777, 0o711])
      expect(() => readRunConfig(env, [], mac, fakeFs(validHandoff, { dirMode }))).toThrow(
        /must be 0700/
      );
  });

  it('refuses a link or anything else that is not a regular file', () => {
    // Catches a symlink pointing the driver at a file the modes were never checked on.
    expect(() => readRunConfig(env, [], mac, fakeFs(validHandoff, { isFile: false }))).toThrow(
      /not a regular file/
    );
    expect(() => readRunConfig(env, [], mac, fakeFs(validHandoff, { link: true }))).toThrow(
      /not a regular file/
    );
  });

  it('refuses a handoff missing any field, naming the field and never its values', () => {
    // Catches a gate handoff format drifting away from what the driver needs.
    const cases: Array<[string, unknown]> = [
      ['origin', { ...validHandoff, origin: undefined }],
      ['communityId', { ...validHandoff, communityId: '' }],
      ['channelId', { ...validHandoff, channelId: undefined }],
      ['owner', { ...validHandoff, owner: { email: 'owner@example.test' } }],
      ['member', { ...validHandoff, member: undefined }],
      ['inviteLink', { ...validHandoff, inviteLink: undefined }],
    ];
    for (const [field, body] of cases) {
      let message = '';
      try {
        readRunConfig(env, [], mac, fakeFs(body));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(new RegExp(`lacks .*${field}`));
      expect(message).not.toContain('secret-password');
    }
    expect(() => readRunConfig(env, [], mac, fakeFs('{ not json'))).toThrow(/not valid JSON/);
  });

  it('refuses a plain-http origin, allowing http only on this machine', () => {
    // Catches credentials being sent in the clear to a remote host.
    for (const origin of ['http://community.example.test', 'ftp://community.example.test'])
      expect(() => readRunConfig(env, [], mac, fakeFs({ ...validHandoff, origin }))).toThrow(
        /origin must be https/
      );
    // The driver's own local dry run: loopback traffic never leaves the machine.
    expect(
      readRunConfig(env, [], mac, fakeFs({ ...validHandoff, origin: 'http://127.0.0.1:5173' }))
        .remote?.origin
    ).toBe('http://127.0.0.1:5173');
  });

  it('refuses a relative handoff path', () => {
    // Catches a path that would resolve against wherever the run happened to start.
    expect(() =>
      readRunConfig({ ...env, [HANDOFF_VARIABLE]: 'handoff.json' }, [], mac, fakeFs())
    ).toThrow(/absolute/);
  });

  it.skipIf(process.platform === 'win32')(
    'checks real file modes on disk, not only the fake ones',
    () => {
      // Catches a mask or stat mistake that the fake file system would hide.
      const dir = mkdtempSync(path.join(os.tmpdir(), 'two-desktop-handoff-'));
      try {
        chmodSync(dir, 0o700);
        const file = path.join(dir, 'handoff.json');
        writeFileSync(file, JSON.stringify(validHandoff), { mode: 0o600 });
        chmodSync(file, 0o600);
        expect(readHandoff(file)).toEqual(validHandoff);
        chmodSync(file, 0o644);
        expect(() => readHandoff(file)).toThrow(/must be 0600/);
        chmodSync(file, 0o600);
        chmodSync(dir, 0o755);
        expect(() => readHandoff(file)).toThrow(/must be 0700/);
        chmodSync(dir, 0o700);
        // A private link to a private file is still a link: O_NOFOLLOW refuses it.
        const link = path.join(dir, 'link.json');
        symlinkSync(file, link);
        expect(() => readHandoff(link)).toThrow(/not a regular file/);
        // A named pipe with the right modes: opening it must not wait for a writer.
        const pipe = path.join(dir, 'pipe.json');
        execFileSync('mkfifo', ['-m', '600', pipe]);
        chmodSync(pipe, 0o600);
        const started = Date.now();
        expect(() => readHandoff(pipe)).toThrow(/not a regular file/);
        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
