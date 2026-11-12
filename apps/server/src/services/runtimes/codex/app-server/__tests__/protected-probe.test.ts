import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  protectedProbe,
  shellControlReturned,
  probeParentKinds,
} from './fixtures/protected-probe.js';

it('reports a stray host file instead of accepting it as an absent parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-parent-kind-'));
  try {
    fs.writeFileSync(path.join(root, '.dork'), '');
    fs.mkdirSync(path.join(root, '.claude'));
    expect(probeParentKinds([root]).map(({ kind }) => kind)).toEqual([
      'directory',
      'file',
      'absent',
      'absent',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('counts only returned shell output as a successful timing control', () => {
  const call = { type: 'function_call', arguments: 'printf PUBLIC-control' };
  expect(shellControlReturned(JSON.stringify({ input: [call] }), 'PUBLIC-control')).toBe(false);
  expect(
    shellControlReturned(
      JSON.stringify({
        input: [call, { type: 'function_call_output', output: 'Permission denied' }],
      }),
      'PUBLIC-control'
    )
  ).toBe(false);
  expect(
    shellControlReturned(
      JSON.stringify({ input: [call, { type: 'function_call_output', output: 'PUBLIC-control' }] }),
      'PUBLIC-control'
    )
  ).toBe(true);
});

it('places the large cwd fixture inside and outside node_modules and removes its own trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-probe-fixture-'));
  const project = path.join(root, 'project');
  try {
    const probe = protectedProbe(root, project, { homeFiles: 20, cwdFiles: 100 });
    const count = (dir: string) =>
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile()).length;
    expect(count(path.join(root, 'home', 'large-tree'))).toBe(20);
    expect(count(path.join(project, 'probe-large-tree'))).toBe(10);
    expect(count(path.join(project, 'node_modules', 'probe-large-tree'))).toBe(90);
    probe.cleanup();
    expect(fs.existsSync(path.join(project, 'probe-large-tree'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'node_modules', 'probe-large-tree'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')(
  'plants distinct lowercase and space-path canaries and quotes commands that really read them',
  () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-path-probe-')));
    const project = path.join(root, 'project');
    try {
      const probe = protectedProbe(root, project, { homeFiles: 0, cwdFiles: 0 });
      expect(probe.desktopCases).toHaveLength(2);
      expect(
        probe.desktopCases.some(({ file }) => file.includes('/Library/Application Support/'))
      ).toBe(true);
      expect(
        probe.desktopCases.some(({ file }) => file.includes('/library/application support/dorkos/'))
      ).toBe(true);
      expect(new Set(probe.desktopCases.map(({ canary }) => canary)).size).toBe(2);
      for (const { file, canary } of probe.desktopCases) {
        expect(fs.readFileSync(file, 'utf8')).toBe(canary);
        expect(probe.canaries).toContain(canary);
        const quoted = "'" + file.replaceAll("'", "'\\''") + "'";
        const command = `cat ${quoted}`;
        expect(probe.command).toContain(command);
        // Positive control for the exact command the real binary will try, on made-up files only.
        expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe(canary);
      }
      probe.cleanup();
      for (const { file } of probe.desktopCases) expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
