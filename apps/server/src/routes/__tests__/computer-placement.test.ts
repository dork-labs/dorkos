import { expect, it, vi } from 'vitest';
const binding = vi.hoisted(() =>
  vi.fn((path: string) => (path === '/computer' ? 'computer-local' : undefined))
);
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { computerRuntimeForAgentPath: binding },
}));
import { projectComputerPlacement, projectComputerPlacementById } from '../computer-placement.js';
it('projects only retained canonical placement and preserves the harness manifest', () => {
  expect(projectComputerPlacement({ projectPath: '/computer', runtime: 'opencode' })).toEqual({
    projectPath: '/computer',
    runtime: 'opencode',
    effectiveRuntimeId: 'computer-local',
  });
  expect(projectComputerPlacement({ projectPath: '/host', runtime: 'opencode' })).toEqual({
    projectPath: '/host',
    runtime: 'opencode',
  });
});

it('projects a path-free response from the authoritative Mesh identity lookup', () => {
  expect(
    projectComputerPlacementById({ id: 'one', runtime: 'opencode' }, [
      { id: 'one', projectPath: '/computer' },
    ])
  ).toEqual({ id: 'one', runtime: 'opencode', effectiveRuntimeId: 'computer-local' });
  expect(
    projectComputerPlacementById({ id: 'foreign', runtime: 'opencode' }, [
      { id: 'one', projectPath: '/computer' },
    ])
  ).toEqual({ id: 'foreign', runtime: 'opencode' });
});
