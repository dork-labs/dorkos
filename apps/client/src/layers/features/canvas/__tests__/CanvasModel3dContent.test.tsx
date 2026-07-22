/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { formatOf } from '../ui/CanvasModel3dContent';

describe('formatOf — 3D extension → renderer format', () => {
  it.each([
    ['assets/robot.glb', 'gltf'],
    ['scene.gltf', 'gltf'],
    ['part.stl', 'stl'],
    ['mesh.obj', 'obj'],
    ['print.3mf', '3mf'],
    ['cloud.PLY', 'ply'],
    ['rig.fbx', 'fbx'],
    ['scene.dae', 'dae'],
  ] as const)('maps %s → %s', (src, expected) => {
    expect(formatOf(src)).toBe(expected);
  });

  it('returns null for an unsupported 3D-ish extension', () => {
    expect(formatOf('model.step')).toBeNull();
    expect(formatOf('noext')).toBeNull();
  });
});
