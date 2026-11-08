import fs from 'node:fs';
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
