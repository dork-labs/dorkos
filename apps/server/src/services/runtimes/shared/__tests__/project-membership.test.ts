import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CodexSessionRegistry } from '../../codex/session-registry.js';
import { OpenCodeSessionRegistry } from '../../opencode/sessions/session-registry.js';
import { TestModeSessionRegistry } from '../../test-mode/session-registry.js';

it.each([CodexSessionRegistry, OpenCodeSessionRegistry, TestModeSessionRegistry])(
  '%s lists both project spellings while keeping the stored working directories',
  (Registry) => {
    const temp = mkdtempSync(path.join(tmpdir(), 'dorkos-project-membership-'));
    try {
      const directory = realpathSync(temp);
      const project = path.join(directory, 'app');
      const alias = path.join(directory, 'linked-app');
      const child = path.join(project, 'nested');
      const sibling = path.join(directory, 'application');
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling);
      symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');

      const registry = new Registry();
      const aliasChild = path.join(alias, 'nested');
      const futureChild = path.join(project, 'not-created', 'nested');
      registry.register('real', { cwd: child });
      registry.register('alias', { cwd: aliasChild });
      registry.register('future', { cwd: futureChild });
      registry.register('sibling', { cwd: sibling });
      registry.register('unbound');

      const expected = [
        { id: 'real', cwd: child },
        { id: 'alias', cwd: aliasChild },
        { id: 'future', cwd: futureChild },
      ];
      for (const requested of [project, alias]) {
        expect(registry.list(requested).map(({ id, cwd }) => ({ id, cwd }))).toEqual(expected);
      }
      expect(registry.list(sibling)).toMatchObject([{ id: 'sibling', cwd: sibling }]);
      expect(registry.get('alias')?.cwd).toBe(aliasChild);
      expect(registry.get('unbound')?.cwd).toBeUndefined();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
);
