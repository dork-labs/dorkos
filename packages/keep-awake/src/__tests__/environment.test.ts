/**
 * Container detection and the per-platform command lines. Each holder's
 * argument vector is pinned because it is what the OS actually runs: the pid
 * must be interpolated as an integer and nothing may pass through a shell.
 */
import { describe, expect, it } from 'vitest';
import { detectEnvironment, holderCommandFor, isContainer } from '../environment.js';
import { windowsExecutionStateScript } from '../holders/windows-execution-state.js';

const bare = { fileExists: () => false, readFile: () => null, env: {} };

describe('isContainer', () => {
  it('is false on a plain machine', () => {
    expect(isContainer(bare)).toBe(false);
  });

  it('detects /.dockerenv', () => {
    expect(isContainer({ ...bare, fileExists: (p) => p === '/.dockerenv' })).toBe(true);
  });

  it.each(['docker', 'containerd', 'kubepods', 'lxc'])('detects a %s cgroup on PID 1', (marker) => {
    const readFile = (p: string) => (p === '/proc/1/cgroup' ? `0::/${marker}/abc123\n` : null);
    expect(isContainer({ ...bare, readFile })).toBe(true);
  });

  it('ignores an ordinary systemd cgroup', () => {
    const readFile = () => '0::/init.scope\n';
    expect(isContainer({ ...bare, readFile })).toBe(false);
  });

  it('detects $container (podman, systemd-nspawn) and ignores it when blank', () => {
    expect(isContainer({ ...bare, env: { container: 'podman' } })).toBe(true);
    expect(isContainer({ ...bare, env: { container: '  ' } })).toBe(false);
  });
});

describe('detectEnvironment', () => {
  it.each([
    ['darwin', 'caffeinate'],
    ['linux', 'systemd-inhibit'],
    ['win32', 'windows-execution-state'],
  ] as const)('picks the %s mechanism', (platform, mechanism) => {
    expect(detectEnvironment({ ...bare, platform })).toEqual({
      platform,
      container: false,
      mechanism,
    });
  });

  it('says platform for an OS with no adapter', () => {
    expect(detectEnvironment({ ...bare, platform: 'freebsd' })).toMatchObject({
      mechanism: 'none',
      reason: 'platform',
    });
  });

  it('says container before anything else', () => {
    expect(detectEnvironment({ ...bare, platform: 'linux', env: { container: 'oci' } })).toEqual({
      platform: 'linux',
      container: true,
      mechanism: 'none',
      reason: 'container',
    });
  });
});

describe('holder command lines', () => {
  it('macOS: caffeinate -i -w <pid> -t <ttl>', () => {
    expect(holderCommandFor('caffeinate', 321, 300)).toEqual({
      mechanism: 'caffeinate',
      command: '/usr/bin/caffeinate',
      args: ['-i', '-w', '321', '-t', '300'],
      renews: true,
    });
  });

  it('Linux: systemd-inhibit around tail --pid=<pid>', () => {
    expect(holderCommandFor('systemd-inhibit', 321, 300)).toEqual({
      mechanism: 'systemd-inhibit',
      command: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--who=DorkOS',
        '--why=Agents are working',
        '--mode=block',
        'tail',
        '--pid=321',
        '-f',
        '/dev/null',
      ],
      renews: false,
    });
  });

  it('Windows: an encoded PowerShell script that sets 0x80000001 and waits on the pid', () => {
    const command = holderCommandFor('windows-execution-state', 321, 300);
    expect(command.command).toBe('powershell.exe');
    expect(command.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    const script = Buffer.from(command.args[5]!, 'base64').toString('utf16le');
    expect(script).toBe(windowsExecutionStateScript(321));
    expect(script).toContain('SetThreadExecutionState');
    expect(script).toContain('0x80000001');
    expect(script).toContain('Wait-Process -Id 321');
    expect(command.renews).toBe(false);
  });

  it('interpolates the pid as an integer, never as text', () => {
    expect(holderCommandFor('caffeinate', 12.9, 300).args).toContain('12');
    expect(windowsExecutionStateScript(12.9)).toContain('Wait-Process -Id 12');
    expect(windowsExecutionStateScript(12.9)).not.toContain('12.9');
  });
});
